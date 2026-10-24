from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import subprocess
import threading
import unittest
from unittest.mock import MagicMock, patch

from openpyxl import Workbook

from tcc_soccer_highlights.streaming_analysis import (
    Job, Journal, complete_workbook, pipeline_lock, run_pipeline,
    fetch_temporary, hf_url, check_video_access, jobs_for,
    download_directory, prepare_download_directory, parse_args,
)
from tcc_soccer_highlights.xlsx_publisher import XlsxPublisher


class StreamingTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(prefix="tmp_pipeline_", dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.videos = self.root / ".pipeline_state/videos"
        self.output = self.root / "analysis_output"
        self.state = self.root / ".pipeline_state"
        self.jobs = [Job("league/season/game", "train", name) for name in ("1_224p.mkv", "2_224p.mkv")]

    def test_download_overlaps_inference_and_discards_both_videos(self):
        second_download = threading.Event()
        maximum = []
        publications = []

        def download(job):
            path = job.video(self.videos)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"video")
            maximum.append(len(list(self.videos.rglob("*.mkv"))))
            if job == self.jobs[1]:
                second_download.set()
            return path

        def analyze(job, video):
            if job == self.jobs[0]:
                self.assertTrue(second_download.wait(5), "O próximo download não ocorreu durante a inferência")
            self.assertTrue(video.exists())
            output = job.workbook(self.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"xlsx")
            return output

        def publish(output):
            self.assertTrue(output.exists())
            publications.append(output)
            return "abc123"

        self.assertEqual(run_pipeline(self.jobs, videos_root=self.videos, output_root=self.output,
            state_dir=self.state, download=download, analyze=analyze, publish=publish,
            valid=lambda p: p.exists(), stop=threading.Event()), 0)
        self.assertEqual(max(maximum), 2)
        self.assertEqual(len(publications), 2)
        self.assertFalse(list(self.videos.rglob("*.mkv")))
        self.assertEqual(Journal(self.state / "jobs").read(self.jobs[0])["stage"], "published")

    def test_failed_push_preserves_xlsx_and_resume_only_republishes(self):
        job = self.jobs[0]
        video = job.video(self.videos)
        output = job.workbook(self.output)

        def download(_):
            video.parent.mkdir(parents=True, exist_ok=True)
            video.write_bytes(b"video")
            return video

        def analyze(*_):
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b"xlsx")
            return output

        def fail(_):
            raise RuntimeError("offline")

        kwargs = dict(videos_root=self.videos, output_root=self.output, state_dir=self.state,
                      download=download, analyze=analyze, valid=lambda p: p.exists())
        with self.assertRaisesRegex(RuntimeError, "offline"):
            run_pipeline([job], **kwargs, publish=fail, stop=threading.Event())
        self.assertTrue(output.exists())
        self.assertFalse(video.exists())
        kwargs.update(download=lambda _: self.fail("Não deveria baixar novamente"),
                      analyze=lambda *_: self.fail("Não deveria inferir novamente"))
        published = []
        run_pipeline([job], **kwargs, publish=lambda p: published.append(p) or "commit", stop=threading.Event())
        self.assertEqual(published, [output])

    def test_failed_inference_cleans_prefetched_video_and_never_publishes(self):
        started = threading.Event()

        def download(job):
            path = job.video(self.videos)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"video")
            if job == self.jobs[1]:
                started.set()
            return path

        def analyze(*_):
            self.assertTrue(started.wait(5))
            raise RuntimeError("inferência falhou")

        with self.assertRaisesRegex(RuntimeError, "inferência falhou"):
            run_pipeline(self.jobs, videos_root=self.videos, output_root=self.output, state_dir=self.state,
                download=download, analyze=analyze, publish=lambda _: self.fail("Não deveria publicar"),
                valid=lambda p: False, stop=threading.Event())
        self.assertFalse(list(self.videos.rglob("*.mkv")))

    def test_completed_existing_workbooks_are_not_overwritten_or_published(self):
        output = self.jobs[0].workbook(self.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"existing")
        forbidden = lambda *_: self.fail("Planilha existente deve ser preservada")
        run_pipeline(self.jobs[:1], videos_root=self.videos, output_root=self.output, state_dir=self.state,
            download=forbidden, analyze=forbidden, publish=forbidden, valid=lambda p: p.exists(), stop=threading.Event())
        self.assertEqual(output.read_bytes(), b"existing")

    def test_lock_prevents_two_runs_and_releases_after_exit(self):
        with pipeline_lock(self.state):
            with self.assertRaisesRegex(RuntimeError, "Já existe"):
                with pipeline_lock(self.state):
                    self.fail("Lock duplicado")
        with pipeline_lock(self.state):
            pass

    def test_partial_or_broken_workbooks_are_not_skipped(self):
        path = self.root / "workbook.xlsx"
        args = SimpleNamespace(model=Path("best.pt"), stride=5, max_seconds=None)
        wb = Workbook()
        meta = wb.active
        meta.title = "metadata"
        meta.append(["status", "duration_sec", "analyzed_duration_sec", "transnet_executed", "yolo_stride", "yolo_model"])
        meta.append(["ok", 100, 60, True, 5, "best.pt"])
        for name in ("samples", "scenes", "events", "event_windows", "scene_summary"):
            sheet = wb.create_sheet(name)
            sheet.append(["value"])
            sheet.append([1])
        wb.save(path)
        self.assertFalse(complete_workbook(path, args))
        args.max_seconds = 60
        self.assertTrue(complete_workbook(path, args))
        args.max_seconds = None
        meta["C2"] = 100
        wb.save(path)
        self.assertTrue(complete_workbook(path, args))
        path.write_bytes(b"broken")
        self.assertFalse(complete_workbook(path, args))

    def test_huggingface_download_is_direct_and_partial_files_are_removed(self):
        target = self.videos / "video.mkv"
        response = MagicMock()
        response.__enter__.return_value = response
        response.status_code = 200
        response.headers = {"Content-Length": "5"}
        response.iter_content.return_value = [b"video"]
        stop = threading.Event()
        with patch("requests.get", return_value=response) as get:
            fetch_temporary("https://huggingface.co/example", target, "test-token", stop)
            self.assertTrue(get.call_args.kwargs["stream"])
        self.assertEqual(target.read_bytes(), b"video")
        self.assertFalse(target.with_suffix(".mkv.partial").exists())
        response.headers = {"Content-Length": "100"}
        with patch("requests.get", return_value=response), self.assertRaises(OSError):
            fetch_temporary("https://huggingface.co/example", target, None, stop)
        self.assertEqual(target.read_bytes(), b"video")
        self.assertFalse(target.with_suffix(".mkv.partial").exists())
        stop.set()
        with patch("requests.get", return_value=response), self.assertRaisesRegex(RuntimeError, "interrompido"):
            fetch_temporary("https://huggingface.co/example", target, None, stop)
        self.assertFalse(target.with_suffix(".mkv.partial").exists())

    def test_huggingface_paths_and_clear_missing_login_error(self):
        self.assertIn("/videos-224p/", hf_url(self.jobs[0]))
        high = Job(self.jobs[0].game, "train", "1_720p.mkv")
        self.assertIn("/videos-720p/", hf_url(high))
        self.assertIn("/SoccerNet/SN-Labels/resolve/main/", hf_url(high, labels=True))
        with self.assertRaisesRegex(PermissionError, "hf auth login"):
            check_video_access(high, None)
        with patch("SoccerNet.utils.getListGames", return_value=["league\\season\\game"]):
            jobs = jobs_for(["train", "valid"], ["1_224p.mkv", "2_224p.mkv"])
        self.assertEqual([j.key for j in jobs], [j.key for j in self.jobs])

    def test_excel_output_is_atomic_if_writer_fails(self):
        from tcc_soccer_highlights.batch_analysis import VideoInfo, analyze_video
        job = self.jobs[0]
        video = job.video(self.videos)
        video.parent.mkdir(parents=True)
        video.write_bytes(b"test")
        output = job.workbook(self.output)
        output.parent.mkdir(parents=True)
        output.write_bytes(b"existing workbook")
        args = SimpleNamespace(videos_root=self.videos, output_root=self.output, model=None,
            stride=5, batch_size=16, max_seconds=None, skip_transnet=True,
            transnet_threshold=.5, event_window=10.)
        info = VideoInfo(video, video.parent, 1, "test")

        def fail(path, *_):
            path.write_bytes(b"partial")
            raise OSError("disk error")

        with patch("tcc_soccer_highlights.batch_analysis.video_metadata", return_value={"fps": 25, "duration_sec": 100}), \
                patch("tcc_soccer_highlights.batch_analysis.write_excel", side_effect=fail):
            with self.assertRaisesRegex(OSError, "disk error"):
                analyze_video(info, args, None, "cpu")
        self.assertEqual(output.read_bytes(), b"existing workbook")
        self.assertFalse(output.with_name(output.stem + ".partial.xlsx").exists())

    def test_external_download_directory_is_saved_without_moving_workbooks_or_state(self):
        project = self.root / "project"
        project.mkdir()
        state = project / ".pipeline_state"
        state.mkdir()
        external = self.root / "another_disk/downloads"
        self.assertEqual(download_directory(project, state), state / "videos")
        selected = download_directory(project, state, external)
        prepare_download_directory(selected, project, state, remember=True)
        self.assertEqual(download_directory(project, state), external)
        self.assertTrue((external / ".tcc_pipeline_owner.json").is_file())
        args = parse_args(["--download-root", str(external)])
        self.assertEqual(args.download_root, external)
        output = project / "analysis_output"
        job = self.jobs[0]

        def download(item):
            path = item.video(external)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"video")
            return path

        def analyze(item, video):
            self.assertTrue(video.is_relative_to(external))
            path = item.workbook(output)
            path.parent.mkdir(parents=True)
            path.write_bytes(b"xlsx")
            return path

        run_pipeline([job], videos_root=external, output_root=output, state_dir=state,
                     download=download, analyze=analyze, publish=lambda _: "commit",
                     valid=lambda p: p.is_file(), stop=threading.Event())
        self.assertTrue(job.workbook(output).exists())
        self.assertFalse(job.video(external).exists())
        self.assertTrue((external / ".tcc_pipeline_owner.json").exists())
        self.assertEqual(Journal(state / "jobs").read(job)["stage"], "published")

    def test_download_directory_refuses_drive_root_and_existing_unrelated_files(self):
        project = self.root / "project"
        project.mkdir()
        state = project / ".pipeline_state"
        state.mkdir()
        for forbidden in [project, state, project / "analysis_output", Path(self.root.anchor)]:
            with self.assertRaises(ValueError):
                download_directory(project, state, forbidden)
        occupied = self.root / "unrelated"
        occupied.mkdir()
        keep = occupied / "keep.txt"
        keep.write_text("preserve")
        with self.assertRaisesRegex(ValueError, "não está vazia"):
            prepare_download_directory(occupied, project, state, remember=True)
        self.assertEqual(keep.read_text(), "preserve")
        owned = self.root / "owned"
        prepare_download_directory(owned, project, state)
        with self.assertRaisesRegex(ValueError, "outro projeto"):
            prepare_download_directory(owned, self.root / "other_project", state)
        with self.assertRaises(ValueError):
            from tcc_soccer_highlights.streaming_analysis import remove_video
            remove_video(keep, owned)


class PublisherTests(unittest.TestCase):
    def test_publish_only_xlsx_with_unmerged_source_index_and_no_duplicate_commit(self):
        with TemporaryDirectory(prefix="tmp_publisher_", dir=Path(__file__).parent) as temp:
            root = Path(temp).resolve()
            project, remote = root / "project", root / "remote.git"
            project.mkdir()

            def git(*args, input=None, cwd=project):
                return subprocess.run(["git", "-C", str(cwd), *args], input=input, text=True,
                                      check=True, capture_output=True).stdout.strip()

            git("init", "--initial-branch=main")
            git("config", "user.name", "Pipeline Test")
            git("config", "user.email", "test@example.com")
            (project / "report.txt").write_text("base")
            git("add", "report.txt")
            git("commit", "-m", "initial")
            git("init", "--bare", str(remote))
            git("remote", "add", "origin", str(remote))
            git("push", "origin", "main")
            blob = git("rev-parse", "HEAD:report.txt")
            git("update-index", "--index-info", input=f"0 {'0'*40}\treport.txt\n100644 {blob} 1\treport.txt\n100644 {blob} 2\treport.txt\n100644 {blob} 3\treport.txt\n")
            (project / "unrelated.txt").write_text("keep local")
            git("add", "unrelated.txt")
            index_before = (project / ".git/index").read_bytes()
            workbook = project / "analysis_output/league/season/game/1_224p_analysis.xlsx"
            workbook.parent.mkdir(parents=True)
            workbook.write_bytes(b"xlsx output")
            publisher = XlsxPublisher(project, project / ".pipeline_state")
            publisher.preflight()
            commit = publisher.publish(workbook)
            self.assertEqual(git("--git-dir", str(remote), "diff-tree", "--no-commit-id", "--name-only", "-r", commit),
                             workbook.relative_to(project).as_posix())
            self.assertEqual(publisher.publish(workbook), commit)
            self.assertEqual((project / ".git/index").read_bytes(), index_before)
            self.assertEqual((project / "unrelated.txt").read_text(), "keep local")
            with self.assertRaises(ValueError):
                publisher.publish(project / "unrelated.txt")


if __name__ == "__main__":
    unittest.main()
