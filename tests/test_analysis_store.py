import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from tcc_soccer_highlights.analysis_store import read_workbook, read_metadata_index, source_signature


class AnalysisStoreTests(unittest.TestCase):
    def test_cached_parquet_matches_excel_and_skips_excel_reader(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            frame=pd.DataFrame({'time_sec':[0.,.2,.4],'player_count':[0,2,3],'label':['Goal','Foul',None]})
            frame.to_excel(source,index=False,sheet_name='samples')
            first=read_workbook(source,root/'cache')
            with patch('tcc_soccer_highlights.analysis_store.pd.read_excel',side_effect=AssertionError('Excel relido')):
                second=read_workbook(source,root/'cache')
            pd.testing.assert_frame_equal(first['samples'],second['samples'])

    def test_changed_source_invalidates_cache(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            pd.DataFrame({'player_count':[0]}).to_excel(source,index=False,sheet_name='samples')
            read_workbook(source,root/'cache')
            pd.DataFrame({'player_count':[12,13]}).to_excel(source,index=False,sheet_name='samples')
            fresh=read_workbook(source,root/'cache')
            self.assertEqual(fresh['samples'].player_count.tolist(),[12,13])

    def test_incomplete_workbook_is_not_published(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            pd.DataFrame({'player_count':[0]}).to_excel(source,index=False)
            with patch('tcc_soccer_highlights.analysis_store.fingerprint',side_effect=[(1,2),(3,4)]):
                with self.assertRaises(OSError): read_workbook(source,root/'cache')
            self.assertFalse(list((root/'cache').rglob('manifest.json')))

    def test_metadata_read_does_not_parse_samples_and_full_load_completes_partial_cache(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample_analysis.xlsx'
            with pd.ExcelWriter(source) as writer:
                pd.DataFrame([{'video_id':'v','duration_sec':100}]).to_excel(writer,sheet_name='metadata',index=False)
                pd.DataFrame({'player_count':[1,2,3]}).to_excel(writer,sheet_name='samples',index=False)
            with patch('tcc_soccer_highlights.analysis_store.pd.read_excel',wraps=pd.read_excel) as reader:
                metadata=read_workbook(source,root/'cache',sheet_names=['metadata'])
                self.assertEqual(list(metadata),['metadata'])
                self.assertEqual(reader.call_args.kwargs['sheet_name'],['metadata'])
                samples=read_workbook(source,root/'cache',sheet_names=['metadata','samples'])
                self.assertEqual(reader.call_args.kwargs['sheet_name'],['samples'])
                self.assertEqual(samples['samples'].player_count.tolist(),[1,2,3])
                complete=read_workbook(source,root/'cache')
                self.assertIsNone(reader.call_args.kwargs['sheet_name'])
                self.assertEqual(set(complete),{'metadata','samples'})
            with patch('tcc_soccer_highlights.analysis_store.pd.read_excel',side_effect=AssertionError('Excel relido')):
                cached=read_workbook(source,root/'cache')
            pd.testing.assert_frame_equal(cached['samples'],complete['samples'])

    def test_persistent_index_only_reloads_changed_metadata_and_removes_deleted_sources(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp)
            def write(name,duration):
                pd.DataFrame([{'video_id':name,'duration_sec':duration}]).to_excel(
                    root/f'{name}_analysis.xlsx',sheet_name='metadata',index=False)
            write('first',100); write('second',200)
            signature=source_signature(root)
            first=read_metadata_index(root,signature)
            self.assertEqual(set(first),{'first','second'})
            with patch('tcc_soccer_highlights.analysis_store.read_workbook',side_effect=AssertionError('Abas relidas')):
                cached=read_metadata_index(root,signature)
            self.assertEqual(cached,first)
            write('second',12345)
            (root/'first_analysis.xlsx').unlink()
            with patch('tcc_soccer_highlights.analysis_store.read_workbook',wraps=read_workbook) as reader:
                changed=read_metadata_index(root,source_signature(root))
                self.assertEqual(reader.call_count,1)
            self.assertEqual(set(changed),{'second'})
            self.assertEqual(changed['second']['meta']['duration_sec'],12345)

    def test_index_retries_invalid_file_when_source_is_replaced(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'bad_analysis.xlsx'
            source.write_bytes(b'broken')
            signature=source_signature(root)
            bad=read_metadata_index(root,signature)
            self.assertIn('error',next(iter(bad.values())))
            with patch('tcc_soccer_highlights.analysis_store.read_workbook',side_effect=AssertionError('Arquivo invalido relido')):
                self.assertEqual(read_metadata_index(root,signature),bad)
            pd.DataFrame([{'video_id':'repaired','duration_sec':100}]).to_excel(source,sheet_name='metadata',index=False)
            repaired=read_metadata_index(root,source_signature(root))
            self.assertEqual(set(repaired),{'repaired'})
