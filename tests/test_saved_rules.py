import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd
from streamlit.testing.v1 import AppTest

from tcc_soccer_highlights import saved_rules
from tcc_soccer_highlights.study_dashboard import cached_simulation
from test_rule_optimizer import INITIAL, records_fixture


CONFIG = {**INITIAL, 'rule': 'zero', 'min_previous': 6, 'drop_fraction': .65}


def save_fixture(path, name='Primeira', config=None, delta=0., labels=None, token='data-v1'):
    records = records_fixture()
    config = config or CONFIG
    labels = ['Goal'] if labels is None else labels
    summary, grouped, _, _ = cached_simulation(records, token, **config, labels=labels, event_delta=delta)
    return saved_rules.save_preset(name, config, labels, delta, dict(recall=.9, reduction=.2),
        records, token, summary, grouped, notes='Priorizar gols', path=path)


class SavedRulesTests(unittest.TestCase):
    def test_snapshots_persist_without_changing_when_controls_or_data_change(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'nested/configurations.json'
            config = dict(CONFIG)
            first = save_fixture(path, config=config)
            config['short'] = 120
            second = save_fixture(path, name='Segunda', config=config)
            entries = saved_rules.read_presets(path)
            self.assertEqual(entries, [first, second])
            self.assertNotEqual(first['id'], second['id'])
            self.assertEqual(entries[0]['config']['short'], 8)
            self.assertEqual(entries[1]['config']['short'], 120)
            self.assertEqual(len(entries[0]['summary']), 3)
            self.assertEqual(entries[0]['by_event'][0]['label'], 'Goal')
            self.assertEqual(list(path.parent.glob('*.tmp')), [])

    def test_undefined_metrics_are_valid_json_and_do_not_meet_goals(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'configurations.json'
            save_fixture(path, labels=['Penalty'])
            text = path.read_text(encoding='utf-8')
            self.assertNotIn('NaN', text)
            entries = json.loads(text)['configurations']
            self.assertIsNone(entries[0]['summary'][0]['recall'])
            self.assertFalse(saved_rules.comparison_table(entries).goal_met.any())

    def test_comparison_keeps_split_goals_and_detects_different_evaluation_contexts(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'configurations.json'
            first = save_fixture(path)
            same = save_fixture(path, config={**CONFIG, 'short': 30})
            different_delta = save_fixture(path, delta=2.)
            different_data = save_fixture(path, token='data-v2')
            different_labels = save_fixture(path, labels=['Goal', 'Corner'])
            self.assertTrue(saved_rules.comparable([first, same]))
            for other in (different_delta, different_data, different_labels):
                self.assertFalse(saved_rules.comparable([first, other]))
            table = saved_rules.comparison_table([first]).set_index('split')
            self.assertEqual(table.loc['treino', 'recall'], 1.)
            self.assertTrue(table.loc['treino', 'goal_met'])
            self.assertFalse(table.loc['teste', 'goal_met'])
            self.assertEqual(table.loc['Todas as partidas', 'missed'], 1)

    def test_damaged_file_is_reported_and_never_overwritten(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / 'configurations.json'
            path.write_text('arquivo incompleto', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Não foi possível ler'):
                save_fixture(path)
            self.assertEqual(path.read_text(encoding='utf-8'), 'arquivo incompleto')


APP_SOURCE = '''
import pandas as pd
import streamlit as st
import tcc_soccer_highlights.study_dashboard as dashboard
from tcc_soccer_highlights.saved_rules_dashboard import render_saved_summary
from test_rule_optimizer import records_fixture
records = records_fixture()
dashboard.cached_study = lambda *_: dict(records=records,
    quality=pd.DataFrame(dict(game=['g1','g2'],events=[2,1],covered_sec=[100.,100.])),
    config=dict(short=8,zero=.8,cluster=2))
mode = st.sidebar.radio('Modo', ['Simulador de regras','Resumo das regras salvas'], key='dashboard_mode')
if mode == 'Resumo das regras salvas':
    render_saved_summary(lambda: dict(records=records), 'current-data')
else:
    dashboard.render(mode, {}, 'current-data')
'''


class SavedRulesDashboardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'configurations.json'
        self.patcher = patch.object(saved_rules, 'PRESETS_PATH', self.path)
        self.patcher.start()

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_save_both_rules_and_restore_all_parameters_events_and_delta(self):
        app = AppTest.from_string(APP_SOURCE, default_timeout=30).run()
        self.assertFalse(app.exception)
        app.selectbox(key='simulator_rule').set_value('context').run()
        app.slider(key='simulator_short').set_value(60)
        app.slider(key='context_drop').set_value(80)
        app.number_input(key='context_min_previous').set_value(8)
        app.number_input(key='simulator_before').set_value(7)
        app.number_input(key='simulator_after').set_value(12)
        app.number_input(key='simulator_event_delta').set_value(2.)
        app.multiselect(key='simulator_events').set_value(['Goal', 'Corner'])
        app.text_input(key='preset_name').set_value('Queda 80%')
        app.number_input(key='preset_goal_recall').set_value(85)
        app.number_input(key='preset_goal_reduction').set_value(70)
        app.text_area(key='preset_notes').set_value('Avaliar gols e escanteios')
        app.button(key='FormSubmitter:save_rule_configuration-Salvar configuração e métricas').click().run()
        self.assertFalse(app.exception)
        first = saved_rules.read_presets()[0]
        self.assertEqual(first['config']['rule'], 'context')
        self.assertEqual(first['config']['short'], 60)
        self.assertEqual(first['event_delta'], 2.)
        self.assertEqual(first['labels'], ['Corner', 'Goal'])
        self.assertEqual(first['goals'], dict(recall=.85, reduction=.7))
        app.selectbox(key='simulator_rule').set_value('zero').run()
        app.slider(key='simulator_short').set_value(8)
        app.number_input(key='simulator_event_delta').set_value(0.)
        app.text_input(key='preset_name').set_value('Original')
        app.button(key='FormSubmitter:save_rule_configuration-Salvar configuração e métricas').click().run()
        self.assertFalse(app.exception)
        self.assertEqual(len(saved_rules.read_presets()), 2)
        self.assertEqual(saved_rules.read_presets()[0], first)
        app.sidebar.radio[0].set_value('Resumo das regras salvas').run()
        self.assertFalse(app.exception)
        app.selectbox(key='saved_restore_choice').set_value(first['id'])
        app.button(key='saved_restore_button').click().run()
        self.assertFalse(app.exception)
        self.assertEqual(app.sidebar.radio[0].value, 'Simulador de regras')
        self.assertEqual(app.selectbox(key='simulator_rule').value, 'context')
        self.assertEqual(app.slider(key='simulator_short').value, 60)
        self.assertEqual(app.slider(key='context_drop').value, 80)
        self.assertEqual(app.number_input(key='context_min_previous').value, 8)
        self.assertEqual(app.number_input(key='simulator_before').value, 7)
        self.assertEqual(app.number_input(key='simulator_after').value, 12)
        self.assertEqual(app.number_input(key='simulator_event_delta').value, 2.)
        self.assertEqual(set(app.multiselect(key='simulator_events').value), {'Goal', 'Corner'})
        self.assertEqual(app.number_input(key='preset_goal_recall').value, 85)

    def test_summary_persists_across_sessions_and_common_evaluation_does_not_replace_snapshot(self):
        first = save_fixture(self.path)
        save_fixture(self.path, name='Contexto', config={**CONFIG, 'rule': 'context'}, delta=2.)
        app = AppTest.from_string(APP_SOURCE, default_timeout=30).run()
        app.sidebar.radio[0].set_value('Resumo das regras salvas').run()
        self.assertFalse(app.exception)
        self.assertTrue(any('diferentes' in w.value for w in app.warning))
        table = next(d.value for d in app.dataframe if 'Atingiu as duas metas' in d.value)
        self.assertEqual(len(table), 2)
        app.button(key='saved_reevaluate').click().run()
        self.assertFalse(app.exception)
        common = app.session_state['saved_common_result'][1]
        self.assertEqual(common.event_delta.unique().tolist(), [0.])
        self.assertEqual(common.dataset.nunique(), 1)
        self.assertEqual(len(common), 6)
        self.assertEqual(saved_rules.read_presets()[0], first)
        app.number_input(key='saved_common_delta').set_value(3.).run()
        self.assertTrue(any('Reavalie' in message.value for message in app.info))
        app.selectbox(key='saved_comparison_split').set_value('teste').run()
        self.assertFalse(app.exception)
        table = next(d.value for d in app.dataframe if 'Atingiu as duas metas' in d.value)
        self.assertEqual(table.Conjunto.unique().tolist(), ['teste'])

    def test_real_summary_route_opens_without_workbooks_or_metadata_loading(self):
        save_fixture(self.path)
        root = Path(self.tmp.name) / 'empty_analyses'
        root.mkdir()
        source = (Path(__file__).parents[1] / 'src/tcc_soccer_highlights/dashboard.py').read_text(encoding='utf-8')
        source = source.replace('OUTPUT_ROOT = Path("analysis_output")', f'OUTPUT_ROOT = Path({str(root)!r})')
        app = AppTest.from_string(source, default_timeout=30)
        app.session_state['dashboard_mode'] = 'Resumo das regras salvas'
        with patch('tcc_soccer_highlights.analysis_store.read_metadata_index') as index_reader, \
                patch('tcc_soccer_highlights.analysis_store.read_workbook') as workbook_reader:
            app.run()
            self.assertFalse(app.exception)
            self.assertTrue(any('Atingiu as duas metas' in d.value for d in app.dataframe))
            index_reader.assert_not_called()
            workbook_reader.assert_not_called()


if __name__ == '__main__':
    unittest.main()
