import unittest

import numpy as np
import pandas as pd
from streamlit.testing.v1 import AppTest

from tcc_soccer_highlights.highlight_study import evaluate, intervals, qualifying_scenes
from tcc_soccer_highlights.study_dashboard import cached_simulation, simulator_timeline
from tcc_soccer_highlights.rule_descriptions import rule_pseudocode
from tcc_soccer_highlights.resolution_comparison import prepare_first_half_pairs, compare_first_halves


def features():
    return pd.DataFrame(dict(scene_id=[1, 2, 3, 4, 5], start_sec=[0, 30, 35, 70, 95],
                             duration_sec=[30, 5, 4, 4, 4], size=[10, 5, 5, 2, 5],
                             zero_fraction=[0, 0, .2, 1, 1], previous_players=[0, 10, 10, 10, 2],
                             mean=[10., 2., 3., 0., 0.]))


CONFIG = dict(short=8, zero=.8, cluster=2, preceding=False, rule='context', min_previous=6, drop_fraction=.65)


class ContextRuleTests(unittest.TestCase):
    def test_relative_drop_accepts_nonzero_detections_and_rejects_missing_context(self):
        f = features()
        self.assertEqual(f.loc[qualifying_scenes(f, 100, **CONFIG), 'scene_id'].tolist(), [2, 3])
        self.assertFalse(qualifying_scenes(f, 100, **{**CONFIG, 'rule': 'zero'}).any())
        self.assertEqual(intervals(f, 100, **CONFIG), [[10., 60.]])
        f.loc[1, 'previous_players'] = np.nan
        self.assertFalse(qualifying_scenes(f, 100, **CONFIG).any())
        # 2 amostras e contexto anterior insuficiente não podem acionar a regra.
        self.assertEqual(f.loc[qualifying_scenes(f, 100, **{**CONFIG, 'cluster': 1}), 'scene_id'].tolist(), [3])

    def test_threshold_boundaries_and_irrelevant_original_controls(self):
        f = features()
        f.loc[1, 'mean'] = 3.5
        expected = qualifying_scenes(f, 100, **CONFIG)
        self.assertTrue(expected.iloc[1])
        actual = qualifying_scenes(f, 100, **{**CONFIG, 'zero': 1., 'preceding': True})
        pd.testing.assert_series_equal(expected, actual)
        for cfg in [dict(rule='unknown'), dict(rule='context', min_previous=0),
                    dict(rule='context', drop_fraction=1.1)]:
            with self.assertRaises(ValueError):
                qualifying_scenes(f, 100, **cfg)

    def test_cached_metrics_timeline_and_annotations_share_the_same_rule(self):
        record = dict(features=features(), events=pd.DataFrame(dict(label=['Goal', 'Corner'], time_sec=[10, 90])),
                      duration=100, game='g', split='treino')
        old, _, _, _ = cached_simulation({'v': record}, 'context-fixture', **{**CONFIG, 'rule': 'zero'})
        new, _, clips, _ = cached_simulation({'v': record}, 'context-fixture', **CONFIG)
        self.assertEqual(old.iloc[0].hits, 0)
        self.assertEqual(new.iloc[0].hits, 1)
        fig, scenes, events = simulator_timeline(record, clips, ['Goal', 'Corner'], CONFIG)
        self.assertEqual(int(scenes.selected.sum()), 2)
        self.assertEqual(events.captured.tolist(), [True, False])
        self.assertEqual(fig.layout.yaxis.title.text, 'Queda relativa de jogadores')
        fig.to_json()
        record['events']['time_sec'] = [80, 90]
        _, changed = evaluate({'v': record}, CONFIG)
        pd.testing.assert_frame_equal(clips, changed)
        pseudo = rule_pseudocode({**CONFIG, 'before': 20, 'after': 25})
        self.assertIn('queda = 1 - atuais / anteriores', pseudo)
        self.assertIn('queda < 0.65', pseudo)

    def test_resolution_comparison_uses_context_rule(self):
        from test_resolution_comparison import paired_items
        items = paired_items()
        for key in ('alow', 'blow'):
            samples = items[key]['samples']
            samples.loc[samples.time_sec.between(30, 34), 'player_count'] = 2
        prepared = prepare_first_half_pairs(items)
        cfg = {**CONFIG, 'cluster': 1}
        new = compare_first_halves(prepared, cfg, ['Goal'])['summary'].set_index('height')
        old = compare_first_halves(prepared, {**cfg, 'rule': 'zero'}, ['Goal'])['summary'].set_index('height')
        self.assertEqual(new.loc[224, 'hits'], 2)
        self.assertEqual(old.loc[224, 'hits'], 0)

    def test_switch_rules_recalculates_page_and_preserves_original_controls(self):
        app = AppTest.from_string('''
import pandas as pd
from test_context_rule import features
import tcc_soccer_highlights.study_dashboard as dashboard
record = dict(features=features(), events=pd.DataFrame(dict(label=['Goal'],time_sec=[10.])),
              duration=100,game='g',split='treino')
dashboard.cached_study = lambda *_: dict(records={'v':record},
    quality=pd.DataFrame(dict(game=['g'],events=[1],covered_sec=[100.])),
    config=dict(short=8,zero=.8,cluster=2))
dashboard.render('Simulador de regras', {}, 'context-ui-test')
''', default_timeout=30).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.iloc[0].hits, 0)
        app.selectbox(key='simulator_rule').set_value('context').run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.iloc[0].hits, 1)
        self.assertFalse(any(button.key == 'optimize_rules' for button in app.button))
        self.assertTrue(app.slider(key='simulator_zero').disabled)
        self.assertTrue(any('queda = 1 - atuais / anteriores' in code.value for code in app.code))
        app.slider(key='context_drop').set_value(95).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.iloc[0].hits, 0)
        app.selectbox(key='simulator_rule').set_value('zero').run()
        self.assertFalse(app.exception)
        self.assertFalse(app.slider(key='simulator_zero').disabled)
        self.assertEqual(app.slider(key='simulator_short').value, 8)
        self.assertEqual(app.slider(key='simulator_zero').value, .8)
        self.assertTrue(any(button.key == 'optimize_rules' for button in app.button))


if __name__ == '__main__':
    unittest.main()
