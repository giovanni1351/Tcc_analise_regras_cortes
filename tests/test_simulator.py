import unittest

import pandas as pd

from tcc_soccer_highlights.highlight_study import evaluate, intervals, qualifying_scenes
from tcc_soccer_highlights.study_dashboard import cached_simulation, event_coverage, simulator_timeline


class SimulatorTests(unittest.TestCase):
    def setUp(self):
        self.features = pd.DataFrame({
            'scene_id': [1, 2, 3, 4, 5], 'start_sec': [0, 30, 35, 70, 95],
            'duration_sec': [30, 5, 4, 4, 4], 'size': [10, 5, 5, 2, 5],
            'zero_fraction': [0, 1, 1, 1, 1], 'previous_players': [0, 8, 8, 8, 2],
            'mean': [10, 0, 0, 0, 0],
        })
        self.events = pd.DataFrame({'label': ['Goal', 'Corner', 'Corner'], 'time_sec': [10, 60, 90]})
        self.proposals = pd.DataFrame({'start_sec': [10], 'end_sec': [60], 'duration_sec': [50]})

    def test_trigger_scenes_share_proposal_conditions(self):
        config = dict(short=8, zero=.8, cluster=2, preceding=True)
        selected = qualifying_scenes(self.features, 100, **config)
        self.assertEqual(self.features.loc[selected, 'scene_id'].tolist(), [2, 3])
        self.assertEqual(intervals(self.features, 100, **config), [[10., 60.]])

    def test_capture_includes_boundaries_and_marks_misses(self):
        result = event_coverage(self.events, self.proposals)
        self.assertEqual(result.captured.tolist(), [True, True, False])
        self.assertEqual(result.proposal.iloc[:2].tolist(), [1, 1])
        self.assertTrue(pd.isna(result.proposal.iloc[2]))

    def test_custom_window_changes_intervals_and_event_capture(self):
        config = dict(short=8, zero=.8, cluster=2, preceding=True)
        record = dict(features=self.features, events=self.events, duration=100, game='g', split='teste')
        default, _ = evaluate({'v': record}, config)
        narrow, clips = evaluate({'v': record}, dict(**config, before=2, after=1))
        self.assertEqual(clips[['start_sec', 'end_sec']].values.tolist(), [[28., 31.], [33., 36.]])
        self.assertEqual(int(default.hits.sum()), 2)
        self.assertEqual(int(narrow.hits.sum()), 0)
        self.assertEqual(intervals(self.features, 100, **config, before=50, after=80), [[0., 100.]])
        self.assertEqual(intervals(self.features, 100, **config, before=0, after=5), [[30., 40.]])
        self.assertEqual(intervals(self.features, 100, **config, before=5, after=0), [[25., 35.]])
        for before, after in [(0, 0), (-1, 5), (5, -1)]:
            with self.assertRaises(ValueError):
                intervals(self.features, 100, before=before, after=after)

    def test_event_filter_and_empty_selection(self):
        record = dict(features=self.features, events=self.events, duration=100)
        config = dict(short=8, zero=.8, cluster=2, preceding=True)
        fig, scenes, events = simulator_timeline(record, self.proposals, ['Corner'], config)
        self.assertEqual(events.label.tolist(), ['Corner', 'Corner'])
        self.assertEqual(events.captured.tolist(), [True, False])
        self.assertEqual(int(scenes.selected.sum()), 2)
        self.assertTrue(any(t.name == 'Corte de câmera' for t in fig.data))
        fig, _, events = simulator_timeline(record, self.proposals.iloc[:0], [], config, False)
        self.assertTrue(events.empty)
        self.assertFalse(any(t.name == 'Corte de câmera' for t in fig.data))
        fig.to_json()

    def test_filter_recalculates_summary_and_cache_without_changing_clips(self):
        records = {'v': dict(features=self.features, events=self.events, duration=100,
                             game='g', split='teste')}
        cached_simulation.clear()
        def run(labels):
            summary, grouped, clips, csv = cached_simulation(records, 'filter-test', 8, .8, 2, True,
                                                            labels=labels)
            return summary.set_index('split').loc['teste'], grouped, clips, csv
        goals, _, original, original_csv = run(('Goal',))
        corners, grouped, clips, csv = run(('Corner',))
        both, _, _, _ = run(('Goal', 'Corner'))
        empty, empty_grouped, _, _ = run(())
        absent, _, _, _ = run(('Penalty',))
        self.assertEqual((goals.events, goals.hits, goals.recall), (1, 1, 1))
        self.assertEqual((corners.events, corners.hits, corners.recall), (2, 1, .5))
        self.assertAlmostEqual(both.recall, 2/3)
        self.assertEqual(corners.proposal_precision, 1)
        self.assertEqual(absent.proposal_precision, 0)
        self.assertTrue(pd.isna(absent.recall))
        self.assertEqual((empty.events, empty.hits), (0, 0))
        self.assertTrue(pd.isna(empty.recall))
        self.assertTrue(pd.isna(empty.proposal_precision))
        self.assertTrue(empty_grouped.empty)
        self.assertEqual(grouped.label.tolist(), ['Corner'])
        self.assertEqual(goals.coverage, corners.coverage)
        pd.testing.assert_frame_equal(original, clips)
        self.assertEqual(original_csv, csv)
        cached_simulation.clear()


    def test_all_matches_row_uses_combined_counts_and_duration(self):
        second_features = pd.concat([self.features, self.features.assign(start_sec=self.features.start_sec + 100)],
                                    ignore_index=True)
        records = {
            'train': dict(features=self.features, events=pd.DataFrame({'label': ['Goal'], 'time_sec': [10]}),
                          duration=100, game='train', split='treino'),
            'test': dict(features=second_features,
                         events=pd.DataFrame({'label': ['Goal'] * 3, 'time_sec': [20, 80, 180]}),
                         duration=400, game='test', split='teste'),
        }
        cached_simulation.clear()
        summary, grouped, clips, _ = cached_simulation(records, 'all-matches', 8, .8, 2, True, labels=('Goal',))
        self.assertEqual(summary.split.tolist(), ['treino', 'teste', 'Todas as partidas'])
        combined = summary.iloc[-1]
        self.assertEqual((combined.events, combined.hits, combined.proposals), (4, 2, 3))
        self.assertAlmostEqual(combined.recall, .5)
        self.assertAlmostEqual(combined.coverage, .3)
        self.assertAlmostEqual(combined.reducao_temporal, .7)
        self.assertAlmostEqual(combined.proposal_precision, 2/3)
        self.assertEqual(len(clips), 3)
        self.assertEqual(set(grouped.split), {'treino', 'teste'})
        empty, _, _, _ = cached_simulation(records, 'all-matches', 8, .8, 2, True, labels=())
        combined = empty.iloc[-1]
        self.assertEqual((combined.events, combined.hits), (0, 0))
        self.assertTrue(pd.isna(combined.recall))
        self.assertTrue(pd.isna(combined.proposal_precision))
        self.assertAlmostEqual(combined.coverage, .3)
        cached_simulation.clear()


if __name__ == '__main__':
    unittest.main()
