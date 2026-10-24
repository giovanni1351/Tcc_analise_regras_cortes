import unittest

import numpy as np
import pandas as pd
from streamlit.testing.v1 import AppTest

from tcc_soccer_highlights.resolution_comparison import prepare_first_half_pairs, compare_first_halves


CONFIG = dict(short=8, zero=.8, cluster=1, preceding=False, before=20, after=25)


def item(game, height, *, half=1, covered=100):
    starts = np.array([0, 30, 35, 60, 90])
    times = np.arange(covered, dtype=float)
    players = np.where((times >= 30) & (times < 35) & (height == 720), 0, 8)
    return dict(meta=dict(competition='league', season='season', game=game, half=half,
                          height=height, duration_sec=100, yolo_stride=1, fps=1),
                samples=pd.DataFrame(dict(time_sec=times, scene_id=np.searchsorted(starts, times, side='right'),
                                          player_count=players)),
                scenes=pd.DataFrame(dict(scene_id=np.arange(1, 6), start_sec=starts,
                                         duration_sec=[30, 5, 25, 30, 10])),
                events=pd.DataFrame(dict(label=['Goal', 'Goal', 'Corner'], time_sec=[10., 80., 40.])))


def paired_items(low=224):
    return {'a720': item('a', 720), 'alow': item('a', low),
            'b720': item('b', 720), 'blow': item('b', low, covered=60),
            'only720': item('unpaired', 720),
            'second720': item('second', 720, half=2), 'secondlow': item('second', low, half=2)}


class ResolutionComparisonTests(unittest.TestCase):
    def test_first_halves_only_common_duration_and_weighted_metrics(self):
        data = prepare_first_half_pairs(paired_items())
        self.assertEqual(data['pairs'].game.tolist(), ['a', 'b'])
        self.assertEqual(data['pairs'].common_sec.tolist(), [100, 60])
        self.assertEqual(data['unmatched'], 1)
        result = compare_first_halves(data, CONFIG, ['Goal', 'Corner'])
        summary = result['summary'].set_index('height')
        self.assertEqual(summary.events.tolist(), [5, 5])
        self.assertEqual(summary.hits.tolist(), [4, 0])
        self.assertEqual(summary.missed.tolist(), [1, 5])
        self.assertEqual(summary.total_sec.tolist(), [160, 160])
        self.assertAlmostEqual(summary.loc[720, 'reduction'], 1 - 90 / 160)
        self.assertEqual(summary.loc[720, 'proposal_precision'], 1)
        self.assertTrue(pd.isna(summary.loc[224, 'proposal_precision']))
        goals = compare_first_halves(data, CONFIG, ['Goal'])['summary'].set_index('height')
        self.assertAlmostEqual(goals.loc[720, 'recall'], 2/3)
        self.assertEqual(goals.loc[224, 'recall'], 0)
        self.assertEqual(len(result['by_game']), 4)

    def test_common_samples_and_same_annotations_are_used(self):
        items = paired_items()
        items['b720']['samples'].loc[lambda f: f.time_sec.ge(60), 'player_count'] = 0
        items['blow']['events'] = items['blow']['events'].iloc[:0]
        data = prepare_first_half_pairs(items)
        record = data['records'][720]['league/season/b']
        self.assertTrue(record['features'].start_sec.lt(60).all())
        self.assertEqual(int(record['features']['size'].sum()), 60)
        pd.testing.assert_frame_equal(record['events'], data['records'][224]['league/season/b']['events'])
        self.assertEqual(record['events'].time_sec.tolist(), [10., 40.])

    def test_rule_changes_event_filters_empty_annotations_and_actual_240p(self):
        items = paired_items(240)
        data = prepare_first_half_pairs(items, 240)
        narrow = compare_first_halves(data, {**CONFIG, 'before': 0, 'after': 1}, ['Goal'])
        self.assertEqual(narrow['summary'].hits.tolist(), [0, 0])
        self.assertEqual(narrow['summary'].height.tolist(), [720, 240])
        empty = compare_first_halves(data, CONFIG, [])
        self.assertTrue(empty['summary'].recall.isna().all())
        self.assertTrue(empty['by_event'].empty)
        for value in items.values():
            value['events'] = value['events'].iloc[:0]
        empty = compare_first_halves(prepare_first_half_pairs(items, 240), CONFIG, ['Goal'])
        self.assertTrue(empty['summary'].recall.isna().all())
        self.assertTrue(empty['summary'].events.eq(0).all())
        missing = prepare_first_half_pairs({'one': item('one', 720)})
        self.assertTrue(compare_first_halves(missing, CONFIG, ['Goal'])['summary'].empty)

    def test_live_comparison_recalculates_for_rule_and_selected_events(self):
        app = AppTest.from_string('''
import streamlit as st
from test_resolution_comparison import paired_items, CONFIG
from tcc_soccer_highlights.study_dashboard import render_first_half_comparison
after = st.number_input('Depois', value=25, min_value=1, key='after')
events = st.multiselect('Eventos', ['Goal', 'Corner'], default=['Goal', 'Corner'], key='events')
render_first_half_comparison(paired_items(), 'paired-ui-test', {**CONFIG, 'after': after}, events)
''', default_timeout=30).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.Cobertos.tolist(), [4, 0])
        self.assertTrue(any('224p, não 240p' in c.value for c in app.caption))
        app.number_input(key='after').set_value(60).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.Cobertos.tolist(), [5, 0])
        app.multiselect(key='events').set_value(['Corner']).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value['Total de eventos'].tolist(), [2, 2])
        self.assertEqual(app.dataframe[1].value.Evento.tolist(), ['Escanteio'])
        app.multiselect(key='events').set_value([]).run()
        self.assertFalse(app.exception)
        self.assertTrue(app.dataframe[1].value.empty)


if __name__ == '__main__':
    unittest.main()
