"""Salvar, restaurar e comparar avaliações das regras no Streamlit."""
import json

import pandas as pd
import plotly.express as px
import streamlit as st

from tcc_soccer_highlights import saved_rules
from tcc_soccer_highlights.rule_descriptions import RULE_NAMES


def queue_preset(entry):
    st.session_state['saved_simulator_pending'] = entry
    if 'dashboard_mode' in st.session_state:
        st.session_state['dashboard_mode'] = 'Simulador de regras'


def apply_pending(records):
    entry = st.session_state.pop('saved_simulator_pending', None)
    if entry is None:
        return
    values = saved_rules.widget_values(entry)
    available = {label for r in records.values() for label in r['events'].label.dropna()}
    missing = set(values['simulator_events']) - available
    values['simulator_events'] = [label for label in values['simulator_events'] if label in available]
    st.session_state.update(values)
    st.session_state.pop('optimizer_pending', None)
    st.session_state.pop('optimizer_result', None)
    st.success(f'Configuração "{entry["name"]}" restaurada. A avaliação usa os dados carregados agora.')
    if missing:
        st.warning('Eventos salvos ausentes nos dados atuais: ' + ', '.join(sorted(missing)))


def _read():
    try:
        return saved_rules.read_presets()
    except (OSError, ValueError) as exc:
        st.error(str(exc))
        return None


def preset_label(entry):
    return f'{entry["name"]} · {RULE_NAMES[entry["config"]["rule"]]} · {entry["created_at"][:19]}'


def render_restore():
    entries = _read()
    if not entries:
        return
    lookup = {p['id']: p for p in entries}
    with st.expander('Restaurar uma configuração salva'):
        selected = st.selectbox('Configuração salva', list(lookup),
            format_func=lambda key: preset_label(lookup[key]), key='simulator_saved_choice')
        st.button('Carregar parâmetros salvos', key='simulator_load_saved',
                  on_click=queue_preset, args=(lookup[selected],))


def render_save(records, token, config, labels, event_delta, summary, grouped):
    st.subheader('Salvar parâmetros e resultado')
    st.caption('Guarda a regra, todos os parâmetros, os eventos, o delta e as métricas atuais. '
               'As metas abaixo servem para avaliar o resultado salvo; não alteram os trechos gerados.')
    with st.form('save_rule_configuration'):
        name = st.text_input('Nome da configuração', key='preset_name',
                             placeholder='Ex.: Gols com maior cobertura')
        cols = st.columns(2)
        target_recall = cols[0].number_input('Meta de recall (%)', min_value=0, max_value=100,
            value=int(st.session_state.get('optimizer_min_recall', 90)), step=1, key='preset_goal_recall')
        target_reduction = cols[1].number_input('Meta de redução temporal (%)', min_value=0,
            max_value=100, value=0, step=1, key='preset_goal_reduction')
        notes = st.text_area('Observações / resultado buscado', key='preset_notes')
        submitted = st.form_submit_button('Salvar configuração e métricas',
                                         disabled=summary is None or not labels)
    if submitted:
        try:
            saved_rules.save_preset(name, config, labels, event_delta,
                dict(recall=target_recall / 100, reduction=target_reduction / 100),
                records, token, summary, grouped, notes=notes)
        except (OSError, ValueError) as exc:
            st.error(str(exc))
        else:
            st.success(f'Configuração "{name.strip()}" salva. Veja o modo Resumo das regras salvas.')
    st.caption(f'Salvamento permanente neste computador: {saved_rules.PRESETS_PATH}. '
               'Cada salvamento cria um registro, preservando os resultados anteriores.')


def display_table(frame, key):
    frame = frame.copy()
    frame['rule'] = frame.rule.map(RULE_NAMES)
    columns = ['name', 'rule', 'split', 'events', 'hits', 'missed', 'recall',
               'reducao_temporal', 'proposal_precision', 'proposals', 'target_recall',
               'target_reduction', 'goal_met', 'event_delta', 'labels', 'videos', 'games', 'created_at']
    percentages = ['recall', 'reducao_temporal', 'proposal_precision', 'target_recall', 'target_reduction']
    names = dict(name='Configuração', rule='Regra', split='Conjunto', events='Eventos', hits='Cobertos',
        missed='Fora dos trechos', recall='Recall (%)', reducao_temporal='Redução temporal (%)',
        proposal_precision='Precisão das propostas (%)', proposals='Propostas',
        target_recall='Meta de recall (%)', target_reduction='Meta de redução (%)',
        goal_met='Atingiu as duas metas', event_delta='Delta (±s)', labels='Eventos selecionados',
        videos='Tempos analisados', games='Partidas', created_at='Salvo em (UTC)')
    for col in percentages:
        frame[col] = pd.to_numeric(frame[col], errors='coerce') * 100
    st.dataframe(frame[columns].rename(columns=names), hide_index=True, width='stretch', key=key,
        column_config={names[col]: st.column_config.NumberColumn(format='%.2f%%') for col in percentages})
    return frame


def _render_chart(frame, key):
    if frame.empty:
        return
    chart = px.scatter(frame, x='reducao_temporal', y='recall', color='rule', text='name',
        hover_data=['proposal_precision', 'hits', 'events'],
        labels=dict(reducao_temporal='Redução temporal (%)', recall='Recall (%)',
                    rule='Regra', name='Configuração', proposal_precision='Precisão (%)'),
        title='Recall e redução temporal — quanto mais acima e à direita, melhor')
    chart.update_traces(textposition='top center', marker_size=12)
    chart.update_xaxes(range=[-2, 102])
    chart.update_yaxes(range=[-2, 102])
    st.plotly_chart(chart, width='stretch', key=key)


def render_saved_summary(load_current=None, token=None):
    st.subheader('Resumo das regras salvas')
    entries = _read()
    if entries is None:
        return
    if not entries:
        st.info('Nenhuma configuração salva. No Simulador de regras, use Salvar parâmetros e resultado.')
        return
    lookup = {p['id']: p for p in entries}
    selected = st.multiselect('Configurações para comparar', list(lookup), default=list(lookup),
        format_func=lambda key: preset_label(lookup[key]), key='saved_comparison_choices')
    entries = [lookup[key] for key in selected]
    if not entries:
        st.info('Selecione ao menos uma configuração.')
        return
    split = st.selectbox('Conjunto da comparação', ['Todas as partidas', 'treino', 'teste'],
                         key='saved_comparison_split')
    st.caption('Resultados registrados no momento de cada salvamento. As duas metas precisam ser '
               'atingidas na linha do conjunto selecionado; sem eventos, o recall é indefinido.')
    if not saved_rules.comparable(entries):
        st.warning('Estas configurações usam dados, eventos ou deltas diferentes. '
                   'Para uma comparação direta, reavalie abaixo usando as mesmas partidas, eventos e delta.')
    all_metrics = saved_rules.comparison_table(entries)
    frame = all_metrics[all_metrics.split.eq(split)]
    plotted = display_table(frame, 'saved_results_table')
    _render_chart(plotted, 'saved_results_chart')
    st.download_button('Exportar resumo (CSV)', all_metrics.to_csv(index=False).encode('utf-8-sig'),
                       file_name='resumo_regras_salvas.csv', key='saved_csv')
    st.download_button('Baixar configurações e resultados (JSON)',
        json.dumps(dict(version=1, configurations=entries), ensure_ascii=False, indent=2, allow_nan=False),
        file_name='regras_salvas.json', mime='application/json', key='saved_json')
    with st.expander('Ver parâmetros, observações e cobertura por evento'):
        for entry in entries:
            st.markdown(f'**{entry["name"]}** — {RULE_NAMES[entry["config"]["rule"]]}')
            if entry['notes']:
                st.write(entry['notes'])
            st.json(dict(parametros=entry['config'], eventos=entry['labels'],
                         delta=entry['event_delta'], metas=entry['goals'], dados=entry['dataset']))
            events = pd.DataFrame(entry['by_event'])
            if not events.empty:
                if split == 'Todas as partidas':
                    events = events.groupby('label', as_index=False)[['events', 'hits']].sum()
                else:
                    events = events[events.split.eq(split)].copy()
                events['Fora dos trechos'] = events.events - events.hits
                events['Recall (%)'] = events.hits / events.events * 100
                st.dataframe(events.rename(columns=dict(label='Evento', events='Total', hits='Cobertos',
                    split='Conjunto')).drop(columns='recall', errors='ignore'), hide_index=True, width='stretch')
    chosen = st.selectbox('Restaurar no simulador', selected,
        format_func=lambda key: preset_label(lookup[key]), key='saved_restore_choice')
    st.button('Abrir configuração no simulador', key='saved_restore_button',
              on_click=queue_preset, args=(lookup[chosen],))
    if load_current is not None:
        _render_common_comparison(entries, split, load_current, token)
    from tcc_soccer_highlights.simulator_glossary import render_simulator_glossary
    with st.expander('Entender as métricas do resumo'):
        render_simulator_glossary()


def _render_common_comparison(entries, split, load_current, token):
    from tcc_soccer_highlights.highlight_study import evaluate, scores

    st.subheader('Comparar nos mesmos dados, eventos e delta')
    st.caption('Reaplica os parâmetros salvos aos dados atuais. Os resultados originais permanecem salvos. '
               'A primeira execução carrega as análises para calcular as métricas.')
    labels = st.multiselect('Eventos para a comparação comum', sorted({x for p in entries for x in p['labels']}),
        default=entries[0]['labels'], key='saved_common_labels')
    delta = st.number_input('Delta comum dos eventos (s)', min_value=0.,
        value=float(entries[0]['event_delta']), step=.5, key='saved_common_delta')
    context = (tuple(p['id'] for p in entries), tuple(sorted(labels)), delta, token)
    if st.button('Reavaliar configurações nos dados atuais', key='saved_reevaluate', disabled=not labels):
        try:
            with st.spinner('Reavaliando as configurações nas mesmas partidas...'):
                records = load_current()['records']
                dataset = saved_rules.dataset_snapshot(records, token)
                current = []
                for entry in entries:
                    evaluation, clips = evaluate(records, entry['config'], event_delta=delta)
                    rows = []
                    for group in ('treino', 'teste', None):
                        metrics = scores(evaluation, clips, records, group, labels=labels, event_delta=delta)
                        rows.append({**metrics, 'split': group or 'Todas as partidas',
                                     'reducao_temporal': 1 - metrics['coverage']})
                    current.append(saved_rules.json_value({**entry, 'dataset': dataset, 'labels': labels,
                        'event_delta': delta, 'summary': rows}))
                st.session_state['saved_common_result'] = (context, saved_rules.comparison_table(current))
        except (ValueError, OSError) as exc:
            st.error(str(exc))
    result = st.session_state.get('saved_common_result')
    if result is not None:
        if result[0] != context:
            st.info('A seleção ou os dados mudaram. Reavalie para atualizar a comparação comum.')
        else:
            st.caption('Resultado recalculado nas mesmas partidas, eventos e delta. As metas continuam sendo '
                       'as de cada configuração. A coluna de data indica o salvamento original dos parâmetros.')
            frame = result[1][result[1].split.eq(split)]
            plotted = display_table(frame, 'saved_common_table')
            _render_chart(plotted, 'saved_common_chart')
            st.download_button('Exportar comparação comum (CSV)',
                result[1].to_csv(index=False).encode('utf-8-sig'), file_name='comparacao_comum_regras.csv',
                key='saved_common_csv')
