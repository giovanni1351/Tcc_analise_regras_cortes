"""Páginas exploratórias do estudo de seleção de candidatos."""
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from plotly.subplots import make_subplots

from tcc_soccer_highlights.highlight_study import TARGETS, evaluate, scores, study, resolution_study, qualifying_scenes
from tcc_soccer_highlights.rule_optimizer import MAX_WINDOW, PARAMETERS, optimize_rules
from tcc_soccer_highlights.resolution_comparison import first_half_versions, prepare_first_half_pairs, compare_first_halves
from tcc_soccer_highlights.simulator_glossary import render_simulator_glossary
from tcc_soccer_highlights.rule_descriptions import RULE_NAMES, rule_pseudocode
from tcc_soccer_highlights.highlight_study import validate_event_delta
from tcc_soccer_highlights.saved_rules_dashboard import apply_pending, render_restore, render_save


@st.cache_resource(show_spinner='Calculando estudo dos vídeos concluídos...', max_entries=2)
def cached_study(_items, token):
    return study(_items)


@st.cache_resource(show_spinner='Comparando resoluções...', max_entries=2)
def cached_resolution(_items, token, config):
    return resolution_study(_items, config)


@st.cache_resource(show_spinner='Preparando primeiros tempos nas duas resoluções...', max_entries=2)
def cached_first_half_pairs(_items, token, low_height):
    return prepare_first_half_pairs(_items, low_height)


@st.cache_data(show_spinner=False, max_entries=64)
def cached_first_half_comparison(_prepared, token, low_height, config, labels, event_delta=0.):
    return compare_first_halves(_prepared, config, labels, event_delta=event_delta)


def render_first_half_comparison(items, token, config, labels, event_delta=0.):
    st.subheader('Comparação de resoluções — primeiro tempo')
    available = sorted({height for versions in first_half_versions(items).values()
                        for height in versions if height in (224, 240)})
    if not available:
        st.info('A comparação precisa de análises do primeiro tempo em 720p e em 224p ou 240p para as mesmas partidas.')
        return
    low = st.selectbox('Resolução menor para comparar com 720p', available,
                       format_func=lambda height: f'{height}p', key='first_half_low_resolution')
    if low == 224 and 240 not in available:
        st.caption('A versão de baixa resolução disponível nestes arquivos é 224p, não 240p.')
    prepared = cached_first_half_pairs(items, token, low)
    pairs = prepared['pairs']
    if pairs.empty:
        st.info(f'Não há primeiros tempos com análises nas duas resoluções: 720p e {low}p.')
        return
    st.caption(f'{len(pairs)} partidas pareadas; {pairs.common_sec.sum() / 3600:.2f} horas por resolução. '
               f'{prepared["unmatched"]} partidas sem par utilizável ficaram fora desta comparação. '
               'Usa os parâmetros atuais e os eventos selecionados, juntando treino e teste. '
               'Somente o período analisado em comum é avaliado; uma análise parcial não representa o tempo completo. '
               'As anotações do SoccerNet presentes no arquivo 720p são usadas como referência para ambas as versões.')
    st.caption(f'Tolerância dos eventos nas duas resoluções: ±{event_delta:g} s.')
    result = cached_first_half_comparison(prepared, token, low, config, tuple(sorted(labels)), event_delta)

    def display_metrics(frame):
        table = frame.copy()
        table['height'] = table.height.map(lambda height: f'{height}p')
        for column in ('recall', 'reduction', 'proposal_precision'):
            table[column] = 100 * table[column]
        return table.rename(columns={'height': 'Resolução', 'games': 'Partidas', 'events': 'Total de eventos',
            'hits': 'Cobertos', 'missed': 'Fora dos trechos', 'recall': 'Cobertura dos eventos (%)',
            'reduction': 'Redução temporal (%)', 'proposal_precision': 'Precisão das propostas (%)',
            'proposals': 'Propostas', 'pair_id': 'Partida'})

    percentages = {name: st.column_config.NumberColumn(format='%.2f%%') for name in
                   ['Cobertura dos eventos (%)', 'Redução temporal (%)', 'Precisão das propostas (%)']}
    summary = display_metrics(result['summary'])
    st.dataframe(summary[['Resolução', 'Partidas', 'Total de eventos', 'Cobertos', 'Fora dos trechos',
                         'Cobertura dos eventos (%)', 'Redução temporal (%)', 'Precisão das propostas (%)', 'Propostas']],
                 hide_index=True, use_container_width=True, column_config=percentages)
    compared = result['summary'].set_index('height')
    cols = st.columns(3)
    for col, column, label in zip(cols, ['recall', 'reduction', 'proposal_precision'],
                                  ['Cobertura dos eventos', 'Redução temporal', 'Precisão das propostas']):
        difference = 100 * (compared.loc[720, column] - compared.loc[low, column])
        col.metric(f'{label}: 720p − {low}p', f'{difference:+.2f} p.p.' if pd.notna(difference) else '—')
    st.caption('Diferenças positivas indicam valores maiores em 720p; negativas, na resolução menor. '
               'As porcentagens são calculadas pelos totais das partidas pareadas, não pela média entre jogos.')
    st.markdown('**Cobertura por tipo de evento nas duas resoluções**')
    events = result['by_event']
    high = events[events.height.eq(720)].set_index('label')
    low_events = events[events.height.eq(low)].set_index('label')
    comparison = pd.DataFrame({'Evento': [EVENT_NAMES.get(label, label) for label in high.index],
                               'Total': high.events.to_numpy()})
    for height, table in [(720, high), (low, low_events.reindex(high.index))]:
        comparison[f'Cobertos {height}p'] = table.hits.to_numpy()
        comparison[f'Fora {height}p'] = table.missed.to_numpy()
        comparison[f'Cobertura {height}p (%)'] = 100 * table.recall.to_numpy()
    st.dataframe(comparison, hide_index=True, use_container_width=True,
                 column_config={f'Cobertura {height}p (%)': st.column_config.NumberColumn(format='%.2f%%')
                                for height in (720, low)})
    with st.expander('Detalhar comparação por partida'):
        detail = display_metrics(result['by_game'])
        st.dataframe(detail[['Partida', 'Resolução', 'Total de eventos', 'Cobertos', 'Fora dos trechos',
                             'Cobertura dos eventos (%)', 'Redução temporal (%)', 'Precisão das propostas (%)']],
                     hide_index=True, use_container_width=True, column_config=percentages)
        st.dataframe(pairs[['game', 'common_sec']].rename(columns={'game': 'Partida', 'common_sec': 'Duração comum (s)'}),
                     hide_index=True, use_container_width=True)
        export = result['by_game'].assign(**config, event_delta=event_delta, selected_events=';'.join(sorted(labels)))
        st.download_button('Exportar comparação dos primeiros tempos', export.to_csv(index=False).encode('utf-8-sig'),
                           file_name=f'primeiro_tempo_720p_vs_{low}p.csv', key='first_half_comparison_download')


@st.cache_data(show_spinner=False, max_entries=128)
def cached_simulation(_records, token, short, zero, cluster, preceding, before=20, after=25, labels=None,
                      rule='zero', min_previous=6., drop_fraction=.65, event_delta=0.):
    evaluation, clips = evaluate(_records, dict(short=short, zero=zero, cluster=cluster, preceding=preceding,
                                               before=before, after=after, rule=rule,
                                               min_previous=min_previous, drop_fraction=drop_fraction), event_delta=event_delta)
    rows = [scores(evaluation, clips, _records, s, labels=labels, event_delta=event_delta) for s in ['treino', 'teste']]
    rows.append({**scores(evaluation, clips, _records, None, labels=labels, event_delta=event_delta), 'split': 'Todas as partidas'})
    summary = pd.DataFrame(rows)
    summary['reducao_temporal'] = 1-summary.coverage
    if labels is not None:
        evaluation = evaluation[evaluation.label.isin(labels)]
    grouped = evaluation.groupby(['split', 'label'])[['events', 'hits']].sum().reset_index()
    grouped['recall'] = grouped.hits/grouped.events
    return summary, grouped, clips, clips.to_csv(index=False).encode('utf-8-sig')


EVENT_NAMES = {
    'Goal': 'Gol', 'Corner': 'Escanteio', 'Shots on target': 'Finalização no gol',
    'Shots off target': 'Finalização para fora', 'Penalty': 'Pênalti',
    'Red card': 'Cartão vermelho', 'Yellow card': 'Cartão amarelo',
    'Yellow->red card': 'Segundo amarelo / vermelho', 'Foul': 'Falta',
    'Offside': 'Impedimento', 'Substitution': 'Substituição',
    'Ball out of play': 'Bola fora', 'Throw-in': 'Lateral',
    'Clearance': 'Afastamento', 'Kick-off': 'Saída de bola',
    'Direct free-kick': 'Falta direta', 'Indirect free-kick': 'Falta indireta',
}


def render_optimizer(records, token, labels, config, current_summary, event_delta=0.):
    st.subheader('Encontrar parâmetros automaticamente')
    st.caption(f'A busca usa a tolerância atual dos eventos: ±{event_delta:g} s. O delta permanece fixo durante a busca.')
    st.caption('Busca completa na grade de parâmetros: maximiza a redução temporal respeitando o recall mínimo. '
               'Cada execução usa o mínimo escolhido nas opções abaixo. '
               'O teste fica separado e pode apresentar resultados diferentes.')
    with st.expander('Opções da busca'):
        min_recall = st.slider('Recall mínimo no treino (%)', 1, 100, 90, 1,
                               key='optimizer_min_recall') / 100
        st.caption('Este valor define o recall mínimo da próxima busca. Reduzir a meta permite '
                   'capturar menos eventos para reduzir mais tempo de vídeo; aumentar a meta exige maior recall. '
                   'Se a meta não for alcançável, os parâmetros serão mantidos. '
                   'Elevar um recall abaixo da meta pode exigir selecionar mais tempo de vídeo.')
        max_window = st.number_input('Limite de cada janela na busca (s)', min_value=1,
                                     max_value=MAX_WINDOW, value=120, step=1, key='optimizer_max_window')
        st.caption(f'Busca: cena máxima de 1 a {max(20, config["short"])} s; fração de zeros de 0 a 100% em passos de 5%; '
                   '1 a 3 cenas agrupadas; exigir jogadores antes ligado/desligado; '
                   'janelas antes/depois em passos de 1 s até o limite acima. '
                   'Todas as combinações dessa grade são avaliadas, sem sorteios.')
        if config['short'] > 20:
            st.caption('A busca foi ampliada para incluir a cena máxima atual. Mais valores aumentam o tempo da busca.')
    training_events = sum(int(r['events'].label.isin(labels).sum())
                          for r in records.values() if r['split'] == 'treino')
    reason = None
    if not labels or not training_events:
        reason = 'Selecione tipos de eventos presentes no treino para habilitar a busca.'
    elif config['before'] + config['after'] <= 0:
        reason = 'Defina uma janela maior que zero para iniciar a busca.'
    elif max(config['before'], config['after']) > max_window:
        reason = 'Aumente o limite da busca para incluir as janelas atuais.'
    if reason:
        st.info(reason)
    context = ('grade_delta_v4', token, tuple(sorted(labels)), min_recall, max_window, event_delta)
    if st.button('Encontrar melhor combinação', type='primary', disabled=reason is not None,
                 key='optimize_rules'):
        bar = st.progress(0., text=f'Preparando a busca com recall mínimo de {min_recall:.0%} no treino...')

        def progress(completed, total, recall):
            bar.progress(completed / total,
                         text=f'{completed}/{total} regras — meta: {min_recall:.0%}; recall: {recall:.1%}')

        try:
            result = optimize_rules(records, labels, config, min_recall=min_recall,
                                    max_window=max_window, progress=progress, event_delta=event_delta)
        except ValueError as exc:
            st.error(str(exc))
        else:
            st.session_state['optimizer_result'] = (context, result)
            # Aplicar antes de recriar os widgets na próxima execução do Streamlit.
            if result.feasible:
                st.session_state['optimizer_pending'] = result.config
            st.rerun()
        finally:
            bar.empty()
    saved = st.session_state.get('optimizer_result')
    if saved and saved[0] == context:
        result = saved[1]
        active = all(config[k] == result.config[k] for k in PARAMETERS)
        if not result.feasible:
            st.warning(f'Nenhuma combinação alcança a meta de {result.target_recall:.2%} no treino. '
                       f'O máximo nesta grade é {result.max_recall:.2%}. Os parâmetros foram mantidos. '
                       'Você pode ampliar o limite das janelas e executar novamente.')
        else:
            if active:
                st.success(f'Busca concluída. A melhor combinação da grade foi aplicada respeitando '
                           f'o recall mínimo escolhido de {result.target_recall:.0%} no treino.')
            else:
                st.info('Os parâmetros foram alterados manualmente. A avaliação abaixo usa os controles atuais.')
        if current_summary is not None:
            current = current_summary.set_index('split').loc['treino']
            cols = st.columns(3)
            for col, column, baseline_key, title in zip(cols,
                    ['recall', 'reducao_temporal'], ['recall', 'reduction'],
                    ['Recall no treino', 'Redução temporal no treino']):
                col.metric(title, f'{current[column]:.1%}',
                           f'{(current[column] - result.baseline[baseline_key]) * 100:+.2f} p.p.')
            cols[2].metric('Recall mínimo usado na última busca', f'{result.target_recall:.2%}')
            st.caption('Avaliação dos parâmetros atuais, atualizada a cada alteração manual. '
                       'Variações em relação aos parâmetros anteriores à última busca. '
                       'As métricas de teste e de todas as partidas aparecem na tabela do simulador.')
        if result.feasible and st.button('Restaurar parâmetros anteriores', key='optimizer_restore'):
            st.session_state['optimizer_pending'] = {k: result.baseline[k] for k in PARAMETERS}
            st.rerun()
        with st.expander('Comparar parâmetros e consultar a busca'):
            st.caption(f'Histórico da última busca: {result.evaluated_combinations:,} combinações avaliadas. '
                       'Os resultados salvos abaixo se referem à busca, antes das alterações manuais.')
            comparison = pd.DataFrame([{'Configuração': 'Antes da busca', **result.baseline},
                                      {'Configuração': 'Melhor encontrada', **result.best}])
            st.dataframe(comparison, hide_index=True, use_container_width=True)
            st.line_chart(result.history.set_index('rules')[['recall', 'reduction']])
            st.caption('O CSV resume a melhor janela viável de cada regra e a configuração inicial.')
            st.download_button('Exportar melhores combinações por regra',
                               result.candidates.to_csv(index=False).encode('utf-8-sig'),
                               file_name='busca_parametros_treino.csv', key='optimizer_download')
    elif saved:
        st.info(f'Os dados, eventos ou opções mudaram. Clique em Encontrar melhor combinação '
                f'para executar uma nova busca com recall mínimo de {min_recall:.0%}.')


def event_coverage(events, proposals, event_delta=0., duration=None):
    event_delta = validate_event_delta(event_delta)
    events = events.copy()
    events['event_start_sec'] = (events.time_sec - event_delta).clip(lower=0)
    events['event_end_sec'] = (events.time_sec + event_delta).clip(upper=duration)
    events['proposal'] = pd.Series(index=events.index, dtype='Int64')
    events['captured_exact'] = False
    for number, clip in enumerate(proposals.itertuples(), 1):
        overlap = events.event_start_sec.le(clip.end_sec) & events.event_end_sec.ge(clip.start_sec)
        events.loc[overlap & events.proposal.isna(), 'proposal'] = number
        events.loc[events.time_sec.between(clip.start_sec, clip.end_sec), 'captured_exact'] = True
    events['captured'] = events.proposal.notna()
    return events


def simulator_timeline(record, proposals, labels, config, show_cuts=True, event_delta=0.):
    features = record['features'].copy()
    features = features[features.start_sec.lt(record['duration'])]
    selected = qualifying_scenes(features, record['duration'], **config)
    contextual = config.get('rule') == 'context'
    if contextual:
        features['player_drop'] = 1 - features['mean'] / features.previous_players.where(features.previous_players.gt(0))
        signal = features.player_drop.clip(0, 1)
        threshold = config.get('drop_fraction', .65)
    else:
        signal = features.zero_fraction
        threshold = config['zero']
    events = event_coverage(record['events'][record['events'].label.isin(labels)], proposals,
                            event_delta=event_delta, duration=record['duration'])
    fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                        row_heights=[.52, .22, .26], vertical_spacing=.09,
                        subplot_titles=['Sinal por cena e limiar da regra',
                                        'Cenas entre cortes', 'Trechos selecionados e eventos reais'])
    for mask, name, color in [(~selected, 'Cena que não aciona a regra', '#94a3b8'),
                               (selected, 'Cena que aciona a regra', '#2563eb')]:
        sub = features[mask]
        custom = np.column_stack([sub.scene_id, sub.duration_sec, sub['size'], sub.previous_players])
        fig.add_trace(go.Scatter(x=sub.start_sec, y=signal[mask], mode='markers',
            name=name, marker=dict(color=color, size=7), customdata=custom,
            hovertemplate='Cena %{customdata[0]} — %{x:.1f}s<br>'
            + ('Queda de jogadores: %{y:.0%}' if contextual else 'Zeros: %{y:.0%}') +
            '<br>Duração: %{customdata[1]:.2f}s<br>Amostras: %{customdata[2]}'
            '<br>Jogadores antes: %{customdata[3]:.1f}<extra>%{fullData.name}</extra>'), row=1, col=1)
    fig.add_hline(y=threshold, line_dash='dash', line_color='#2563eb', row=1, col=1,
                  annotation_text=f'Limiar: {threshold:.0%}')
    colors = ['#2563eb' if hit else ('#e2e8f0' if i % 2 else '#94a3b8')
              for i, hit in enumerate(selected)]
    fig.add_trace(go.Bar(x=np.minimum(features.duration_sec, record['duration']-features.start_sec),
        base=features.start_sec, y=['Cenas']*len(features), orientation='h',
        marker=dict(color=colors, line=dict(color='white', width=1)), showlegend=False,
        customdata=np.column_stack([features.scene_id, features.start_sec, features.duration_sec]),
        hovertext=features['mean'].map(lambda value: f'{value:.1f}' if pd.notna(value) else 'Sem amostras'),
        hovertemplate='Cena %{customdata[0]}<br>Início / corte: %{customdata[1]:.2f}s'
                      '<br>Duração: %{customdata[2]:.2f}s'
                      '<br>Média de jogadores na cena (YOLO): %{hovertext}<extra></extra>'), row=2, col=1)
    if show_cuts:
        cuts = features.loc[features.start_sec.gt(0), 'start_sec']
        x = [v for t in cuts for v in (t, t, None)]
        fig.add_trace(go.Scatter(x=x, y=[-.05, 1.05, None]*len(cuts), mode='lines',
            line=dict(color='rgba(100,116,139,.22)', width=1), name='Corte de câmera',
            hoverinfo='skip'), row=1, col=1)
    fig.add_trace(go.Bar(x=proposals.duration_sec, base=proposals.start_sec,
        y=['Trechos']*len(proposals), orientation='h', name='Trecho capturado',
        marker=dict(color='#86efac', line=dict(color='#16a34a', width=1)),
        customdata=np.array([[i, c.start_sec, c.end_sec] for i,c in enumerate(proposals.itertuples(),1)]).reshape(-1,3),
        hovertemplate='Trecho %{customdata[0]}<br>%{customdata[1]:.1f}s — %{customdata[2]:.1f}s'
                      '<br>Duração: %{x:.1f}s<extra></extra>'), row=3, col=1)
    for c in proposals.itertuples():
        fig.add_vrect(x0=c.start_sec, x1=c.end_sec, fillcolor='#22c55e', opacity=.09,
                      line_width=0, row=1, col=1)
    for captured, name, color, symbol in [(True, 'Evento capturado', '#15803d', 'diamond'),
                                         (False, 'Evento fora dos trechos', '#dc2626', 'x')]:
        ev = events[events.captured.eq(captured)]
        fig.add_trace(go.Scatter(x=ev.time_sec, y=['Eventos']*len(ev), mode='markers',
            name=name, marker=dict(color=color, size=11, symbol=symbol),
            text=ev.label.map(lambda x: EVENT_NAMES.get(x,x)),
            customdata=ev[['event_start_sec', 'event_end_sec']].to_numpy(),
            error_x=dict(type='data', symmetric=False, array=ev.event_end_sec - ev.time_sec,
                         arrayminus=ev.time_sec - ev.event_start_sec, visible=event_delta > 0),
            hovertemplate='%{text}<br>Anotação: %{x:.1f}s<br>Intervalo: %{customdata[0]:.2f}s — '
                          '%{customdata[1]:.2f}s<extra>%{fullData.name}</extra>'), row=3, col=1)
    fig.update_layout(height=700, barmode='overlay', legend=dict(orientation='h', y=-.2),
                      margin=dict(b=120), hovermode='closest')
    fig.update_yaxes(title_text='Queda relativa de jogadores' if contextual else 'Amostras sem jogadores',
                     tickformat='.0%', range=[-.06,1.12], row=1,col=1)
    fig.update_xaxes(range=[0,record['duration']])
    fig.update_xaxes(title_text='Tempo no vídeo (segundos) — arraste para ampliar', row=3,col=1)
    return fig, features.assign(selected=selected), events


def render(mode, items, token):
    if mode == 'Relatório do estudo':
        root=Path('reports/highlight_study')
        st.subheader('Relatório para o grupo de TCC')
        st.info('O PDF é uma fotografia dos arquivos completos. Para atualizar: .venv/Scripts/python.exe -m tcc_soccer_highlights.highlight_study')
        for filename,label in [('relatorio_eventos_cortes_yolo.pdf','Baixar relatório PDF'),('regras_e_metodologia.md','Baixar regras e metodologia'),('clips.csv','Baixar candidatos para a LLM'),('snapshot.json','Baixar registro da fotografia')]:
            path=root/filename
            if path.exists(): st.download_button(label,path.read_bytes(),file_name=filename)
        path=root/'regras_e_metodologia.md'
        if path.exists(): st.markdown(path.read_text(encoding='utf-8'))
        return
    result=cached_study(items, token)
    q=result['quality']
    cols=st.columns(4)
    event_total = cols[2].empty()
    for col,(label,value) in zip(cols,[('Partidas únicas',q.game.nunique()),('Tempos únicos',len(q)),('Eventos',int(q.events.sum())),('Horas com YOLO',f'{q.covered_sec.sum()/3600:.1f}')]):
        (event_total if label == 'Eventos' else col).metric(label,value)
    st.caption('Maior resolução disponível por partida/tempo. Zero jogadores é indício de câmera fora do domínio do YOLO (close/replay), não confirmação automática de replay.')
    if mode == 'Eventos, cortes e YOLO':
        tabs=st.tabs(['Antes e depois','Perfil temporal','Incerteza e controles','Resolução e amostra'])
        ev=result['events']
        with tabs[0]:
            label=st.multiselect('Tipos de evento',sorted(ev.label.unique()),default=[x for x in TARGETS if x in ev.label.unique()])
            metric=st.selectbox('Sinal',['cuts','short_zero','zero_fraction','players'],format_func=lambda x:{'cuts':'Cortes em 30 s','short_zero':'Cenas curtas com zeros frequentes','zero_fraction':'Fração de zero detecções','players':'Jogadores detectados (média)'}[x])
            sub=ev[ev.label.isin(label)]
            if len(sub):
                means=sub.groupby('label')[[f'pre_{metric}',f'post_{metric}']].mean().reset_index().melt('label',var_name='janela',value_name='valor')
                st.plotly_chart(px.bar(means,x='label',y='valor',color='janela',barmode='group'),use_container_width=True)
                binary=sub.assign(padrao=sub.post_short_zero.ge(1)).groupby('label').agg(eventos=('time_sec','size'),taxa_padrao=('padrao','mean'))
                st.dataframe(binary,use_container_width=True)
            st.caption('Janelas [-30,0) e [0,30) s. Eventos perto das bordas são excluídos desta comparação. As médias acima são por evento; os contrastes com incerteza usam partidas como unidade.')
        with tabs[1]:
            labels=st.multiselect('Curvas por evento',sorted(result['lag'].label.unique()),default=[x for x in ['Goal','Shots on target','Ball out of play'] if x in ev.label.unique()])
            sub=result['lag'][result['lag'].label.isin(labels)]
            agg=sub.groupby(['game','label','lag_sec'],as_index=False).players.mean().groupby(['label','lag_sec'],as_index=False).players.mean()
            agg['centro_janela_sec']=agg.lag_sec+2.5
            fig=px.line(agg,x='centro_janela_sec',y='players',color='label',markers=True,
                        labels={'centro_janela_sec':'Segundos relativos à anotação','players':'Média de jogadores detectados pelo YOLO','label':'Evento'})
            fig.add_vline(x=0,line_dash='dash',line_color='black')
            fig.update_yaxes(rangemode='tozero')
            st.plotly_chart(fig,use_container_width=True)
            st.caption('Linha mais alta = mais jogadores detectados em média. Cada ponto resume 5 s e indica o centro da janela. Média primeiro dentro de cada partida, depois entre partidas. A contagem real de jogadores mostrados pode diferir das detecções. Janelas de eventos próximos podem compartilhar cenas.')
        with tabs[2]:
            st.dataframe(result['effects'],hide_index=True,use_container_width=True)
            st.caption('Depois menos antes/controle; IC95% bootstrap de 2.000 reamostragens de partidas. Controles: centro >60 s de qualquer anotação. Intervalo incluindo zero indica incerteza sobre a diferença.')
            st.dataframe(result['paired'],hide_index=True,use_container_width=True)
        with tabs[3]:
            res=result['resolutions']
            st.plotly_chart(px.box(res,x='height',y='zero_fraction',points='all',hover_data=['game','half']),use_container_width=True)
            st.dataframe(q,hide_index=True,use_container_width=True)
            st.subheader('224p × 720p no mesmo conteúdo')
            pairs, resolution_filter = cached_resolution(items, token, result['config'])
            st.dataframe(pairs,hide_index=True,use_container_width=True)
            st.dataframe(resolution_filter,hide_index=True,use_container_width=True)
            st.caption('Pareamento por partida/tempo e timestamp. zero_224_given_open720 mede zeros em 224p quando 720p detecta ≥6 jogadores. 720p é referência operacional, não ground truth. Tempo de processamento inclui todo o pipeline.')
    else:
        st.subheader('Simulador de filtros para a LLM')
        st.warning('Ajustar parâmetros olhando o teste torna o resultado exploratório. A regra do PDF foi escolhida somente no treino. As anotações são usadas apenas para avaliar, nunca para gerar candidatos.')
        apply_pending(result['records'])
        render_restore()
        rule = st.selectbox('Regra para analisar', list(RULE_NAMES), format_func=RULE_NAMES.get,
                            key='simulator_rule')
        contextual = rule == 'context'
        if contextual:
            st.info('Hipótese: uma queda forte de jogadores detectados após um trecho com vários jogadores '
                    'pode indicar mudança de enquadramento ligada a um lance. A regra aceita cenas com '
                    'alguns jogadores detectados; não exige zerar as detecções e não confirma um evento sozinha.')
        config = result['config']
        defaults = dict(short=int(config['short']), zero=float(config['zero']),
                        cluster=int(config['cluster']), preceding=False, before=20, after=25)
        for name, value in defaults.items():
            st.session_state.setdefault(f'simulator_{name}', value)
        pending = st.session_state.pop('optimizer_pending', None)
        if pending:
            for name, value in pending.items():
                st.session_state[f'simulator_{name}'] = value
        columns=st.columns(4)
        short=columns[0].slider('Cena máxima (s)',1,120, key='simulator_short')
        zero=columns[1].slider('Fração de zeros',0.,1.,step=.05, key='simulator_zero', disabled=contextual)
        cluster=columns[2].selectbox('Cenas qualificadas em ±10 s',[1,2,3], key='simulator_cluster')
        preceding=columns[3].checkbox('Exigir ≥6 jogadores antes',value=False, key='simulator_preceding', disabled=contextual)
        with st.expander('Parâmetros da nova regra', expanded=contextual):
            min_previous = st.number_input('Média mínima de jogadores nos 15 s anteriores',
                                           min_value=1, max_value=30, value=6, step=1,
                                           key='context_min_previous', disabled=not contextual)
            drop_fraction = st.slider('Queda mínima de jogadores (%)', 0, 100, 65, 5,
                                       key='context_drop', disabled=not contextual) / 100
            st.caption('Queda = 1 − média na cena / média nos 15 s anteriores. '
                       'Exemplo: de 10 para 3 jogadores detectados = queda de 70%. '
                       'A nova regra exige a média anterior mínima e a queda escolhidas. '
                       'Fração de zeros e a exigência fixa de ≥6 pertencem somente à regra atual.')
        window_columns = st.columns(2)
        before = window_columns[0].number_input('Tempo antes do início da cena (s)', min_value=0,
                                                step=1, key='simulator_before')
        after = window_columns[1].number_input('Tempo depois do início da cena (s)', min_value=0,
                                               step=1, key='simulator_after')
        st.caption(f'Intervalo de análise: início da cena − {before} s até início da cena + {after} s. '
                   'Os limites respeitam a duração analisada do vídeo; intervalos sobrepostos são unidos.')
        base_config = dict(short=short, zero=zero, cluster=cluster, preceding=preceding, before=before, after=after)
        rule_config = dict(**base_config, rule=rule, min_previous=min_previous, drop_fraction=drop_fraction)
        with st.expander('Pseudocódigo da regra selecionada', expanded=True):
            st.code(rule_pseudocode(rule_config), language='text')
            st.caption('Os valores acima acompanham os controles. Cortes e detecções geram os trechos; '
                       'as anotações do SoccerNet entram somente depois, para medir os acertos e as perdas.')
        labels = sorted({label for record in result['records'].values() for label in record['events'].label.dropna()})
        selected_labels = st.multiselect('Tipos de eventos da análise', labels, default=[x for x in TARGETS if x in labels],
            format_func=lambda x: EVENT_NAMES.get(x, x), key='simulator_events')
        st.caption('A seleção define os eventos usados nas contagens, no recall, na precisão e nos gráficos. '
                   'A regra continua definindo os trechos e sua cobertura temporal.')
        event_delta = st.number_input('Delta dos eventos (s)', min_value=0., value=0., step=.5,
                                       key='simulator_event_delta',
                                       help='Segundos antes e depois do instante anotado. Zero usa apenas o instante original.')
        st.caption(f'Cada evento é avaliado de t − {event_delta:g} s até t + {event_delta:g} s '
                   f'(intervalo de {2 * event_delta:g} s, limitado ao período analisado). '
                   'Basta algum trecho selecionado tocar ou sobrepor esse intervalo para contar um acerto. '
                   'O delta altera a avaliação, sem aumentar os trechos gerados. '
                   'A proximidade temporal não confirma que o trecho mostre um replay daquele evento.')
        with st.expander('Como o intervalo do evento entra na avaliação'):
            st.code(f'''delta = {event_delta:g} segundos
para cada evento selecionado:
    inicio_evento = max(0, instante_anotado - delta)
    fim_evento = min(duracao_analisada, instante_anotado + delta)
    coberto = existe trecho com:
        trecho.inicio <= fim_evento E trecho.fim >= inicio_evento
    contar o evento uma única vez, mesmo se vários trechos o cobrirem
recall = quantidade_de_eventos_cobertos / total_de_eventos_selecionados''', language='text')
        summary = None
        if before + after > 0:
            summary, grouped, clips, csv_bytes = cached_simulation(result['records'], token, **rule_config,
                                                                  labels=tuple(sorted(selected_labels)), event_delta=event_delta)
        if not contextual:
            render_optimizer(result['records'], token, selected_labels, base_config, summary, event_delta=event_delta)
        else:
            st.caption('A nova regra é ajustada manualmente. A busca automática existente continua disponível na regra atual.')
        if before + after == 0:
            st.warning('Defina um tempo maior que zero em pelo menos um dos lados para gerar intervalos de análise.')
            render_simulator_glossary()
            return
        overall = summary.loc[summary.split.eq('Todas as partidas')].iloc[0]
        event_total.metric('Eventos selecionados', int(overall.events))
        st.subheader('Cobertura dos eventos selecionados — todas as partidas')
        event_columns = st.columns(3 if event_delta > 0 else 2)
        event_columns[0].metric('Cobertura dos eventos selecionados',
                                f'{overall.recall:.2%}' if overall.events else '—')
        event_columns[1].metric('Eventos selecionados cobertos',
                                f'{int(overall.hits)} de {int(overall.events)}')
        if event_delta > 0:
            exact_summary, _, _, _ = cached_simulation(result['records'], token, **rule_config,
                                                       labels=tuple(sorted(selected_labels)), event_delta=0.)
            exact = exact_summary.loc[exact_summary.split.eq('Todas as partidas')].iloc[0]
            event_columns[2].metric('Recall sem tolerância', f'{exact.recall:.2%}' if exact.events else '—')
            st.caption(f'Com ±{event_delta:g} s: {int(overall.hits - exact.hits)} evento(s) adicional(is) coberto(s), '
                       'usando os mesmos trechos. O cartão sem tolerância usa o instante original.')
        st.caption('Eventos selecionados cobertos ÷ total de eventos selecionados (recall). '
                   '100% significa que o intervalo de cada evento intersecta algum trecho gerado pelos parâmetros atuais. '
                   'Cada evento é contado uma vez. Esta porcentagem mede eventos, não duração de vídeo.')
        if not overall.events:
            st.info('Sem eventos dos tipos selecionados nas partidas analisadas; a cobertura de eventos é indefinida.')
        st.dataframe(summary,hide_index=True,use_container_width=True)
        st.caption('Resultados por conjunto, considerando apenas os tipos selecionados. '
                   'Todas as partidas reúne treino e teste: as métricas são calculadas pelos totais, '
                   'não pela média das duas linhas. '
                   'Recall = eventos selecionados capturados / total de eventos selecionados. '
                   'Precisão = propostas com ao menos um evento selecionado / total de propostas. '
                   'Cobertura = união dos trechos / duração. Recall sem eventos é indefinido (campo vazio).')
        render_save(result['records'], token, rule_config, selected_labels, event_delta, summary, grouped)
        st.subheader('Comparação entre as duas regras')
        other_rule = 'zero' if contextual else 'context'
        other_summary, _, _, _ = cached_simulation(result['records'], token,
            **{**rule_config, 'rule': other_rule}, labels=tuple(sorted(selected_labels)), event_delta=event_delta)
        comparison = pd.concat([summary.assign(Regra=RULE_NAMES[rule]),
                                other_summary.assign(Regra=RULE_NAMES[other_rule])], ignore_index=True)
        comparison['Fora dos trechos'] = comparison.events - comparison.hits
        for column in ['recall', 'reducao_temporal', 'proposal_precision']:
            comparison[column] *= 100
        comparison = comparison.rename(columns={'split': 'Conjunto', 'events': 'Total', 'hits': 'Cobertos',
            'recall': 'Cobertura dos eventos (%)', 'reducao_temporal': 'Redução temporal (%)',
            'proposal_precision': 'Precisão das propostas (%)'})
        st.dataframe(comparison[['Regra', 'Conjunto', 'Total', 'Cobertos', 'Fora dos trechos',
                                 'Cobertura dos eventos (%)', 'Redução temporal (%)', 'Precisão das propostas (%)']],
                     hide_index=True, use_container_width=True,
                     column_config={name: st.column_config.NumberColumn(format='%.2f%%') for name in
                                    ['Cobertura dos eventos (%)', 'Redução temporal (%)', 'Precisão das propostas (%)']})
        st.caption('Mesmas partidas, eventos, delta, duração máxima de cena, agrupamento e janelas antes/depois. '
                   'Cada regra usa seus próprios critérios de detecção. Ganhar recall pode custar mais tempo selecionado; '
                   'confira também a precisão das propostas e o conjunto de teste.')
        filtered = grouped[grouped.label.isin(selected_labels)].copy()
        st.subheader('Eventos cobertos e fora dos trechos — todas as partidas')
        event_table = filtered.groupby('label', as_index=False)[['events', 'hits']].sum()
        event_table['Fora dos trechos'] = event_table.events - event_table.hits
        event_table['Cobertura (%)'] = 100 * event_table.hits / event_table.events.replace(0, np.nan)
        event_table['Evento'] = event_table.label.map(lambda label: EVENT_NAMES.get(label, label))
        event_table = event_table.rename(columns={'events': 'Total', 'hits': 'Cobertos'})
        event_table = event_table[['Evento', 'Total', 'Cobertos', 'Fora dos trechos', 'Cobertura (%)']]
        event_table = event_table.sort_values(['Fora dos trechos', 'Evento'], ascending=[False, True])
        st.dataframe(event_table, hide_index=True, use_container_width=True,
                     column_config={'Cobertura (%)': st.column_config.NumberColumn(format='%.2f%%')},
                     key='simulator_event_coverage')
        st.caption('Somente os tipos de evento selecionados, somando treino e teste. '
                   'Fora dos trechos = total − cobertos. Os tipos com mais eventos fora aparecem primeiro. '
                   'A tabela acompanha os parâmetros atuais da regra.')
        if len(filtered):
            filtered['evento'] = filtered.label.map(lambda x: EVENT_NAMES.get(x,x))
            chart = px.bar(filtered,x='evento',y='recall',color='split',barmode='group',hover_data=['hits','events'],
                           labels={'recall':'Eventos capturados', 'evento':'Evento', 'split':'Conjunto'},
                           title='Captura por tipo de evento — todos os vídeos')
            chart.update_yaxes(tickformat='.0%', range=[0,1])
            st.plotly_chart(chart,use_container_width=True)
        render_first_half_comparison(items, token, rule_config, selected_labels, event_delta=event_delta)
        key=st.selectbox('Inspecionar propostas no vídeo',list(result['records']))
        r = result['records'][key]
        proposals = clips[clips.video_id.eq(key)].copy()
        config_now = {k: v for k, v in rule_config.items() if k not in ('before', 'after')}
        description = (f'Nova regra: cena de até {short} s, média anterior de pelo menos {min_previous} jogadores '
                       f'nos 15 s anteriores e queda de pelo menos {drop_fraction:.0%} na média da cena. '
                       if contextual else
                       f'Regra atual: cena de até {short} s, pelo menos {zero:.0%} das amostras sem jogadores. '
                       + ('Exige média de pelo menos 6 jogadores nos 15 s anteriores. ' if preceding else ''))
        st.info(description +
                f'No mínimo 3 amostras YOLO. Exige {cluster} cena(s) qualificada(s) em ±10 s '
                '(incluindo a própria cena). '
                + f'Cada cena aprovada captura {before} s antes e {after} s depois de seu início; trechos sobrepostos são unidos.')
        show_cuts = st.checkbox('Mostrar linhas dos cortes de câmera', value=True)
        timeline, scenes, events = simulator_timeline(r, proposals, selected_labels, config_now, show_cuts,
                                                     event_delta=event_delta)
        cols = st.columns(5)
        cols[0].metric('Cenas que acionam a regra', int(scenes.selected.sum()))
        cols[1].metric('Trechos selecionados', len(proposals))
        cols[2].metric('Tempo selecionado', f'{proposals.duration_sec.sum()/60:.1f} min')
        cols[3].metric('Eventos filtrados capturados', f'{int(events.captured.sum())} / {len(events)}')
        cols[4].metric('Recall no vídeo', f'{events.captured.mean():.1%}' if len(events) else '—')
        st.plotly_chart(timeline,use_container_width=True)
        st.caption(('Cada ponto mostra a queda relativa de jogadores em relação aos 15 s anteriores; '
                    'aumentos de jogadores aparecem como 0%. Sem média anterior positiva, o ponto fica indefinido. '
                    if contextual else
                    'Cada ponto representa uma cena: 100% significa que todas as amostras YOLO ficaram sem jogadores; '
                    '0% significa que nenhuma ficou sem jogadores. ') + 'Azul indica cenas que acionam a regra. '
                   'As divisões na faixa de cenas são os cortes. Verde indica os trechos capturados. '
                   'Losangos verdes são eventos cobertos com o delta atual; X vermelhos são eventos fora. '
                   'As barras horizontais nos eventos mostram seus intervalos de tolerância. '
                   'Cenas sem amostras não têm ponto e não acionam a regra. Use o zoom para inspecionar cortes próximos.')
        if not selected_labels:
            st.info('Nenhum tipo de evento selecionado. Selecione, por exemplo, Gol e Escanteio para inspecionar sua captura.')
        elif events.empty:
            st.info('Este vídeo não tem eventos dos tipos selecionados.')
        if proposals.empty:
            st.info('Nenhum trecho atende à regra atual neste vídeo.')
        tabs = st.tabs(['Eventos capturados e perdidos', 'Trechos selecionados', 'Cenas que acionam a regra'])
        with tabs[0]:
            table = events[['label','time_sec','event_start_sec','event_end_sec','captured_exact','captured','proposal']].copy()
            table['label'] = table.label.map(lambda x: EVENT_NAMES.get(x,x))
            table['captured'] = table.captured.map({True:'Capturado', False:'Fora dos trechos'})
            table['captured_exact'] = table.captured_exact.map({True:'Sim', False:'Não'})
            st.dataframe(table.rename(columns={'label':'Evento','time_sec':'Instante (s)',
                'event_start_sec':'Início do evento (s)', 'event_end_sec':'Fim do evento (s)',
                'captured_exact':'Coberto sem tolerância',
                'captured':'Resultado','proposal':'Trecho'}),hide_index=True,use_container_width=True)
        with tabs[1]:
            table = proposals[['start_sec','end_sec','duration_sec']].copy()
            table.insert(0, 'Trecho', range(1,len(table)+1))
            st.dataframe(table.rename(columns={'start_sec':'Início (s)','end_sec':'Fim (s)',
                'duration_sec':'Duração (s)'}),hide_index=True,use_container_width=True)
        with tabs[2]:
            fields = ['scene_id','start_sec','duration_sec','zero_fraction','size','previous_players']
            if contextual:
                fields += ['mean', 'player_drop']
            st.dataframe(scenes.loc[scenes.selected, fields]
                .rename(columns={'scene_id':'Cena','start_sec':'Início (s)','duration_sec':'Duração (s)',
                    'zero_fraction':'Fração de zeros','size':'Amostras YOLO','previous_players':'Média de jogadores antes',
                    'mean': 'Média de jogadores na cena', 'player_drop': 'Queda relativa de jogadores'}),
                hide_index=True,use_container_width=True)
        st.download_button('Exportar candidatos desta configuração',csv_bytes,file_name='candidatos_llm.csv')
        st.caption(f'Candidatos recuperam {before} s antes e {after} s depois do início de cena. Intervalos sobrepostos são unidos. Propostas longas precisam ser segmentadas antes do envio.')
        render_simulator_glossary()
