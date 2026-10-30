import unittest
from itertools import product

import numpy as np
import pandas as pd
from streamlit.testing.v1 import AppTest

from tcc_soccer_highlights.highlight_study import evaluate, scores
from tcc_soccer_highlights.rule_optimizer import TrainingEvaluator, optimize_rules


def records_fixture():
    features = pd.DataFrame(dict(scene_id=[1, 2, 3, 4], start_sec=[0., 30., 35., 90.],
                                 duration_sec=[30., 5., 4., 10.], size=[10, 5, 5, 5],
                                 zero_fraction=[0., 1., 1., .5], previous_players=[0., 8., 8., 2.],
                                 mean=[10., 0., 0., 2.]))
    return {'train': dict(features=features, duration=100., game='g1', split='treino',
                          events=pd.DataFrame(dict(label=['Goal', 'Corner'], time_sec=[30., 70.]))),
            'test': dict(features=features.copy(), duration=100., game='g2', split='teste',
                         events=pd.DataFrame(dict(label=['Goal'], time_sec=[90.])))}


INITIAL = dict(short=8, zero=.8, cluster=2, preceding=False, before=20, after=25)


class OptimizerTests(unittest.TestCase):
    def test_search_includes_scenes_longer_than_twenty_seconds(self):
        records = records_fixture()
        records['train']['features'] = records['train']['features'].assign(
            duration_sec=[100., 25., 25., 100.])
        records['train']['events'] = pd.DataFrame(dict(label=['Goal'], time_sec=[32.]))
        initial = {**INITIAL, 'short': 30, 'before': 1, 'after': 1}
        result = optimize_rules(records, ['Goal'], initial, max_window=3)
        self.assertEqual(result.baseline['recall'], 0.)
        self.assertTrue(result.feasible)
        self.assertEqual(result.best['recall'], 1.)
        self.assertGreaterEqual(result.config['short'], 25)
        self.assertLessEqual(result.config['short'], 30)
        self.assertEqual(result.evaluated_combinations, 30 * 21 * 3 * 2 * 15)

    def test_preserves_ninety_percent_recall_instead_of_trading_it_for_time(self):
        records = records_fixture()
        records['train']['events'] = pd.DataFrame(dict(label=['Goal'] * 10,
                                                      time_sec=[*range(21, 30), 90]))
        initial = {**INITIAL, 'before': 9, 'after': 1}
        result = optimize_rules(records, ['Goal'], initial, max_window=10)
        self.assertEqual(result.baseline['recall'], .9)
        self.assertTrue(result.feasible)
        self.assertGreaterEqual(result.best['recall'], .9)
        self.assertGreaterEqual(result.best['reduction'] + 1e-12, result.baseline['reduction'])

    def test_grid_matches_direct_evaluation_for_every_window(self):
        records = records_fixture()
        records['train']['events'] = pd.DataFrame(dict(label=['Goal'] * 7,
                                                      time_sec=[0., 28., 30., 31., 35., 90., 100.]))
        records['extra'] = {**records['train'], 'duration': 103.7,
                            'features': records['train']['features'].assign(start_sec=[.3, 15.1, 17.1, 90.7]),
                            'events': pd.DataFrame(dict(label=['Goal'] * 5, time_sec=[13.1, 15.1, 17.1, 19.1, 96.7]))}
        records['empty'] = {**records['train'], 'events': records['train']['events'].iloc[:0]}
        evaluator = TrainingEvaluator(records, ['Goal'])
        for rule in [dict(short=8, zero=.8, cluster=2, preceding=False),
                     dict(short=1, zero=1., cluster=3, preceding=True),
                     dict(short=20, zero=0., cluster=1, preceding=False)]:
            hits, selected = evaluator.window_grid(rule, 6)
            for before, after in product(range(7), repeat=2):
                if before + after == 0:
                    continue
                direct = evaluator.evaluate(dict(**rule, before=before, after=after))
                self.assertEqual(hits[before, after], direct['hits'])
                self.assertAlmostEqual(selected[before, after], direct['selected_sec'])

    def test_global_optimum_matches_independent_exhaustive_reference(self):
        records = records_fixture()
        initial = {**INITIAL, 'before': 1, 'after': 1}
        result = optimize_rules(records, ['Goal'], initial, max_window=3)
        # Estes valores representam todas as máscaras distintas desta fixture.
        reference = []
        for short, zero, cluster, preceding, before, after in product(
                [1, 4, 5, 10, 20], [0., .05, .55, 1.], [1, 2, 3], [False, True], range(4), range(4)):
            if before + after == 0:
                continue
            evaluation, clips = evaluate(records, dict(short=short, zero=zero, cluster=cluster,
                                                        preceding=preceding, before=before, after=after))
            value = scores(evaluation, clips, records, 'treino', labels=['Goal'])
            if value['recall'] >= result.target_recall:
                reference.append((1 - value['coverage'], value['recall']))
        self.assertEqual((result.best['reduction'], result.best['recall']), max(reference))
        self.assertEqual(result.evaluated_combinations, 2520 * 15)

    def test_fast_metrics_match_simulator_including_boundaries(self):
        records = records_fixture()
        rng = np.random.default_rng(7)
        # Vídeo sem eventos também deve entrar no denominador da cobertura temporal.
        records['empty'] = {**records['train'], 'duration': 200.,
                            'events': records['train']['events'].iloc[:0]}
        records['train']['events'] = pd.DataFrame(dict(
            label=['Goal'] * 9, time_sec=[0., 10., 30., 35., 55., 60., 70., 90., 100.]))
        evaluator = TrainingEvaluator(records, ['Goal'])
        configs = [INITIAL, {**INITIAL, 'before': 0, 'after': 5},
                   {**INITIAL, 'before': 5, 'after': 0},
                   {**INITIAL, 'before': 120, 'after': 120}]
        for _ in range(25):
            configs.append(dict(short=int(rng.integers(1, 21)), zero=float(rng.integers(0, 21) / 20),
                                cluster=int(rng.integers(1, 4)), preceding=bool(rng.integers(2)),
                                before=int(rng.integers(0, 121)), after=int(rng.integers(1, 121))))
        for config in configs:
            with self.subTest(config=config):
                evaluation, clips = evaluate(records, config)
                expected = scores(evaluation, clips, records, 'treino', labels=['Goal'])
                actual = evaluator.evaluate(config)
                self.assertEqual(actual['hits'], expected['hits'])
                self.assertEqual(actual['events'], expected['events'])
                self.assertAlmostEqual(actual['recall'], expected['recall'])
                self.assertAlmostEqual(actual['reduction'], 1 - expected['coverage'])

    def test_search_improves_reproducibly_and_never_uses_test(self):
        records = records_fixture()
        progress = []
        kwargs = dict(max_window=25)
        first = optimize_rules(records, ['Goal'], INITIAL, progress=lambda *x: progress.append(x), **kwargs)
        records['test'] = {'split': 'teste'}  # A busca não pode sequer acessar seus dados.
        second = optimize_rules(records, ['Goal'], INITIAL, **kwargs)
        self.assertEqual(first.config, second.config)
        pd.testing.assert_frame_equal(first.candidates, second.candidates)
        self.assertGreater(first.best['reduction'], first.baseline['reduction'])
        self.assertEqual(first.best['recall'], 1.)
        self.assertEqual(first.target_recall, .9)
        self.assertTrue(first.history.reduction.diff().dropna().ge(-1e-12).all())
        self.assertEqual(progress[-1][:2], (2520, 2520))
        self.assertTrue(first.candidates.before.between(0, 100).all())
        self.assertTrue(first.candidates.after.between(0, 100).all())
        self.assertTrue((first.candidates.before + first.candidates.after).gt(0).all())
        evaluator = TrainingEvaluator(records, ['Goal'])
        self.assertEqual(first.best['recall'], evaluator.evaluate(first.config)['recall'])

    def test_unreachable_target_keeps_original_configuration(self):
        records = records_fixture()
        records['train']['features']['size'] = 0
        result = optimize_rules(records, ['Goal'], INITIAL, max_window=25)
        self.assertFalse(result.feasible)
        self.assertEqual(result.max_recall, 0)
        self.assertEqual(result.config, INITIAL)
        self.assertEqual(result.best, result.baseline)

    def test_missing_training_events_and_invalid_windows(self):
        records = records_fixture()
        for labels in ([], ['Penalty']):
            with self.assertRaisesRegex(ValueError, 'eventos'):
                optimize_rules(records, labels, INITIAL)
        with self.assertRaisesRegex(ValueError, 'treino'):
            optimize_rules({'test': records['test']}, ['Goal'], INITIAL)
        for value in (0, 1.1, float('nan')):
            with self.assertRaises(ValueError):
                optimize_rules(records, ['Goal'], INITIAL, min_recall=value)
        for config, limit in [({**INITIAL, 'before': 0, 'after': 0}, 120),
                              ({**INITIAL, 'before': -1}, 120), (INITIAL, 10)]:
            with self.assertRaises(ValueError):
                optimize_rules(records, ['Goal'], config, max_window=limit)


class OptimizerDashboardTests(unittest.TestCase):
    def app(self, no_scenes=False, multiple_events=False, mixed_events=False):
        # Usa a página real com um estudo pequeno para testar botão, rerun e todos os widgets.
        source = '''
import pandas as pd
import tcc_soccer_highlights.study_dashboard as dashboard
features = pd.DataFrame(dict(scene_id=[1,2,3], start_sec=[0.,30.,35.],
    duration_sec=[30.,5.,4.], size=[10,5,5], zero_fraction=[0.,1.,1.],
    previous_players=[0.,8.,8.], mean=[10.,0.,0.]))
records = {split: dict(features=features, duration=100., game=split, split=split,
    events=pd.DataFrame(dict(label=['Goal'], time_sec=[30.]))) for split in ['treino','teste']}
dashboard.cached_study = lambda *_: dict(records=records,
    quality=pd.DataFrame(dict(game=['treino','teste'], events=[1,1], covered_sec=[100.,100.])),
    config=dict(short=8, zero=.8, cluster=2))
dashboard.render('Simulador de regras', {}, 'fixture')
'''
        if no_scenes:
            source = source.replace('size=[10,5,5]', 'size=[0,0,0]').replace("'fixture'", "'fixture-no-scenes'")
        if multiple_events:
            source = source.replace("label=['Goal'], time_sec=[30.]",
                                    "label=['Goal'] * 10, time_sec=[*range(21, 30), 90]")
            source = source.replace("'fixture'", "'fixture-multiple-events'")
        if mixed_events:
            source = source.replace("label=['Goal'], time_sec=[30.]",
                                    "label=['Goal'] * 10 + ['Corner'] * 2, time_sec=[*range(21, 30), 90, 10, 80]")
            source = source.replace("'fixture'", "'fixture-mixed-events'")
        return AppTest.from_string(source, default_timeout=30).run()

    def test_larger_scene_limit_is_preserved_between_rules(self):
        app = self.app()
        app.slider(key='simulator_short').set_value(60).run()
        self.assertFalse(app.exception)
        self.assertEqual(app.slider(key='simulator_short').value, 60)
        app.selectbox(key='simulator_rule').set_value('context').run()
        self.assertFalse(app.exception)
        self.assertEqual(app.slider(key='simulator_short').value, 60)
        app.slider(key='simulator_short').set_value(120).run()
        app.selectbox(key='simulator_rule').set_value('zero').run()
        self.assertFalse(app.exception)
        self.assertEqual(app.slider(key='simulator_short').value, 120)

    def test_event_table_counts_missed_events_and_tracks_rule_and_selection(self):
        app = self.app(mixed_events=True)
        app.multiselect(key='simulator_events').set_value(['Goal', 'Corner']).run()

        def table():
            self.assertFalse(app.exception)
            return next(d.value for d in app.dataframe
                        if 'Fora dos trechos' in d.value.columns and 'Evento' in d.value.columns).set_index('Evento')

        result = table()
        self.assertEqual(result.loc['Gol'].tolist(), [20, 18, 2, 90.])
        self.assertEqual(result.loc['Escanteio'].tolist(), [4, 2, 2, 50.])
        summary = next(d.value for d in app.dataframe if 'coverage' in d.value.columns)
        overall = summary.set_index('split').loc['Todas as partidas']
        self.assertEqual(result.Total.sum(), overall.events)
        self.assertEqual(result.Cobertos.sum(), overall.hits)
        app.number_input(key='simulator_after').set_value(60).run()
        self.assertTrue(table()['Fora dos trechos'].eq(0).all())
        self.assertTrue(table()['Cobertura (%)'].eq(100).all())
        app.slider(key='simulator_short').set_value(1).run()
        self.assertTrue(table().Cobertos.eq(0).all())
        self.assertEqual(table()['Fora dos trechos'].tolist(), [20, 4])
        app.multiselect(key='simulator_events').set_value(['Corner']).run()
        self.assertEqual(table().index.tolist(), ['Escanteio'])
        app.multiselect(key='simulator_events').set_value([]).run()
        self.assertTrue(table().empty)

    def test_changed_recall_target_is_used_when_lowered_and_raised(self):
        app = self.app(multiple_events=True)
        app.number_input(key='optimizer_max_window').set_value(60).run()
        app.button(key='optimize_rules').click().run()
        self.assertFalse(app.exception)
        first = app.session_state['optimizer_result'][1]
        self.assertEqual(first.target_recall, .9)
        self.assertEqual(first.best['recall'], .9)

        app.slider(key='optimizer_min_recall').set_value(80).run()
        self.assertFalse(app.success)
        self.assertTrue(any('nova busca com recall mínimo de 80%' in info.value for info in app.info))
        app.button(key='optimize_rules').click().run()
        self.assertFalse(app.exception)
        lower = app.session_state['optimizer_result'][1]
        self.assertEqual(lower.baseline['recall'], first.best['recall'])
        self.assertEqual(lower.target_recall, .8)
        self.assertEqual(lower.best['recall'], .8)
        self.assertGreater(lower.best['reduction'], first.best['reduction'])
        self.assertNotEqual(lower.config, first.config)

        app.slider(key='optimizer_min_recall').set_value(100).run()
        app.button(key='optimize_rules').click().run()
        self.assertFalse(app.exception)
        higher = app.session_state['optimizer_result'][1]
        self.assertEqual(higher.target_recall, 1.)
        self.assertEqual(higher.best['recall'], 1.)
        for name, expected in higher.config.items():
            self.assertEqual(app.session_state[f'simulator_{name}'], expected)

    def test_click_applies_all_parameters_and_updates_simulation(self):
        app = self.app()
        self.assertFalse(app.exception)
        self.assertEqual(app.dataframe[0].value.split.tolist(), ['treino', 'teste', 'Todas as partidas'])
        event_count = next(metric for metric in app.metric if metric.label == 'Eventos selecionados')
        self.assertEqual(event_count.value, '2')
        app.number_input(key='optimizer_max_window').set_value(25).run()
        app.button(key='optimize_rules').click().run()
        self.assertFalse(app.exception, [e.message for e in app.exception])
        result = app.session_state['optimizer_result'][1]
        for name, expected in result.config.items():
            self.assertEqual(app.session_state[f'simulator_{name}'], expected)
        self.assertTrue(any('aplicada' in s.value for s in app.success))
        summary = next(d.value for d in app.dataframe if 'coverage' in d.value.columns)
        train = summary.set_index('split').loc['treino']
        self.assertAlmostEqual(train.recall, result.best['recall'])
        self.assertAlmostEqual(1 - train.coverage, result.best['reduction'])
        self.assertGreaterEqual(train.recall, result.baseline['recall'])
        app.button(key='optimizer_restore').click().run()
        for name in result.config:
            self.assertEqual(app.session_state[f'simulator_{name}'], result.baseline[name])
        app.number_input(key='simulator_after').set_value(result.config['after'] + 1).run()
        self.assertFalse(app.exception)
        self.assertTrue(any('alterados manualmente' in s.value for s in app.info))
        app.multiselect(key='simulator_events').set_value([]).run()
        self.assertTrue(app.button(key='optimize_rules').disabled)
        self.assertFalse(app.success)

    def test_invalid_windows_disable_search_and_recover(self):
        app = self.app()
        app.number_input(key='simulator_before').set_value(0)
        app.number_input(key='simulator_after').set_value(0).run()
        self.assertFalse(app.exception)
        self.assertTrue(app.button(key='optimize_rules').disabled)
        app.number_input(key='simulator_after').set_value(121).run()
        self.assertTrue(app.button(key='optimize_rules').disabled)
        app.number_input(key='optimizer_max_window').set_value(150).run()
        self.assertFalse(app.button(key='optimize_rules').disabled)

    def test_manual_edit_after_search_updates_metrics_and_all_summary_rows(self):
        app = self.app()
        app.number_input(key='optimizer_max_window').set_value(25).run()
        app.button(key='optimize_rules').click().run()
        saved_result = app.session_state['optimizer_result'][1]
        self.assertEqual(saved_result.best['recall'], 1.)
        app.slider(key='simulator_short').set_value(1).run()
        self.assertFalse(app.exception)
        summary = next(d.value for d in app.dataframe if 'coverage' in d.value.columns)
        self.assertTrue(summary.recall.eq(0).all())
        self.assertTrue(summary.reducao_temporal.eq(1).all())
        recall = next(metric for metric in app.metric if metric.label == 'Recall no treino')
        reduction = next(metric for metric in app.metric if metric.label == 'Redução temporal no treino')
        self.assertEqual(recall.value, '0.0%')
        self.assertEqual(reduction.value, '100.0%')
        self.assertEqual(app.session_state['optimizer_result'][1].best, saved_result.best)
        app.slider(key='simulator_short').set_value(8).run()
        self.assertFalse(app.exception)
        recall = next(metric for metric in app.metric if metric.label == 'Recall no treino')
        self.assertEqual(recall.value, '100.0%')

    def test_selected_event_coverage_tracks_current_parameters_and_empty_selection(self):
        app = self.app(multiple_events=True)

        def coverage():
            return next(metric.value for metric in app.metric
                        if metric.label == 'Cobertura dos eventos selecionados')

        def counts():
            return next(metric.value for metric in app.metric
                        if metric.label == 'Eventos selecionados cobertos')

        self.assertFalse(app.exception)
        self.assertEqual(coverage(), '90.00%')
        self.assertEqual(counts(), '18 de 20')
        app.number_input(key='simulator_after').set_value(60).run()
        self.assertFalse(app.exception)
        self.assertEqual(coverage(), '100.00%')
        self.assertEqual(counts(), '20 de 20')
        app.slider(key='simulator_short').set_value(1).run()
        self.assertFalse(app.exception)
        self.assertEqual(coverage(), '0.00%')
        self.assertEqual(counts(), '0 de 20')
        app.multiselect(key='simulator_events').set_value([]).run()
        self.assertFalse(app.exception)
        self.assertEqual(coverage(), '—')
        self.assertEqual(counts(), '0 de 0')

    def test_unreachable_target_does_not_apply_a_lower_recall_result(self):
        app = self.app(no_scenes=True)
        app.number_input(key='optimizer_max_window').set_value(25).run()
        initial = {k: app.session_state[f'simulator_{k}'] for k in INITIAL}
        app.button(key='optimize_rules').click().run()
        self.assertFalse(app.exception)
        self.assertFalse(app.success)
        self.assertTrue(any('parâmetros foram mantidos' in w.value for w in app.warning))
        for key, value in initial.items():
            self.assertEqual(app.session_state[f'simulator_{key}'], value)


if __name__ == '__main__':
    unittest.main()
