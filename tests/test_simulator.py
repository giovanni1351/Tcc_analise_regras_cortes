import unittest

import pandas as pd

from tcc_soccer_highlights.highlight_study import evaluate, intervals, qualifying_scenes
from tcc_soccer_highlights.study_dashboard import event_coverage, simulator_timeline


class SimulatorTests(unittest.TestCase):
    def setUp(self):
        self.features = pd.DataFrame({
            'scene_id': [1, 2, 3, 4, 5], 'start_sec': [0, 30, 35, 70, 95],
            'duration_sec': [30, 5, 4, 4, 4], 'size': [10, 5, 5, 2, 5],
            'zero_fraction': [0, 1, 1, 1, 1], 'previous_players': [0, 8, 8, 8, 2],
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


if __name__ == '__main__':
    unittest.main()
