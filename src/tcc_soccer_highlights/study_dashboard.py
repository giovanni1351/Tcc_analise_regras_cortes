"""Páginas exploratórias do estudo de seleção de candidatos."""
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from plotly.subplots import make_subplots

from tcc_soccer_highlights.highlight_study import TARGETS, evaluate, scores, study, resolution_study, qualifying_scenes


@st.cache_resource(show_spinner='Calculando estudo dos vídeos concluídos...', max_entries=2)
def cached_study(_items, token):
    return study(_items)


@st.cache_resource(show_spinner='Comparando resoluções...', max_entries=2)
def cached_resolution(_items, token, config):
    return resolution_study(_items, config)


@st.cache_data(show_spinner=False, max_entries=128)
def cached_simulation(_records, token, short, zero, cluster, preceding, before=20, after=25):
    evaluation, clips = evaluate(_records, dict(short=short, zero=zero, cluster=cluster, preceding=preceding,
                                               before=before, after=after))
    summary = pd.DataFrame([scores(evaluation, clips, _records, s) for s in ['treino', 'teste']])
    summary['reducao_temporal'] = 1-summary.coverage
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


def event_coverage(events, proposals):
    events = events.copy()
    events['proposal'] = pd.Series(index=events.index, dtype='Int64')
    for number, clip in enumerate(proposals.itertuples(), 1):
        events.loc[events.time_sec.between(clip.start_sec, clip.end_sec), 'proposal'] = number
    events['captured'] = events.proposal.notna()
    return events


def simulator_timeline(record, proposals, labels, config, show_cuts=True):
    features = record['features'].copy()
    features = features[features.start_sec.lt(record['duration'])]
    selected = qualifying_scenes(features, record['duration'], **config)
    events = event_coverage(record['events'][record['events'].label.isin(labels)], proposals)
    fig = make_subplots(rows=3, cols=1, shared_xaxes=True,
                        row_heights=[.52, .22, .26], vertical_spacing=.09,
                        subplot_titles=['Sinal por cena e limiar da regra',
                                        'Cenas entre cortes', 'Trechos selecionados e eventos reais'])
    for mask, name, color in [(~selected, 'Cena que não aciona a regra', '#94a3b8'),
                               (selected, 'Cena que aciona a regra', '#2563eb')]:
        sub = features[mask]
        custom = np.column_stack([sub.scene_id, sub.duration_sec, sub['size'], sub.previous_players])
        fig.add_trace(go.Scatter(x=sub.start_sec, y=sub.zero_fraction, mode='markers',
            name=name, marker=dict(color=color, size=7), customdata=custom,
            hovertemplate='Cena %{customdata[0]} — %{x:.1f}s<br>Zeros: %{y:.0%}'
            '<br>Duração: %{customdata[1]:.2f}s<br>Amostras: %{customdata[2]}'
            '<br>Jogadores antes: %{customdata[3]:.1f}<extra>%{fullData.name}</extra>'), row=1, col=1)
    fig.add_hline(y=config['zero'], line_dash='dash', line_color='#2563eb', row=1, col=1,
                  annotation_text=f"Limiar: {config['zero']:.0%}")
    colors = ['#2563eb' if hit else ('#e2e8f0' if i % 2 else '#94a3b8')
              for i, hit in enumerate(selected)]
    fig.add_trace(go.Bar(x=np.minimum(features.duration_sec, record['duration']-features.start_sec),
        base=features.start_sec, y=['Cenas']*len(features), orientation='h',
        marker=dict(color=colors, line=dict(color='white', width=1)), showlegend=False,
        customdata=np.column_stack([features.scene_id, features.start_sec, features.duration_sec]),
        hovertemplate='Cena %{customdata[0]}<br>Início / corte: %{customdata[1]:.2f}s'
                      '<br>Duração: %{customdata[2]:.2f}s<extra></extra>'), row=2, col=1)
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
            hovertemplate='%{text}<br>%{x:.1f}s<extra>%{fullData.name}</extra>'), row=3, col=1)
    fig.update_layout(height=700, barmode='overlay', legend=dict(orientation='h', y=-.2),
                      margin=dict(b=120), hovermode='closest')
    fig.update_yaxes(title_text='Amostras sem jogadores', tickformat='.0%', range=[-.06,1.12], row=1,col=1)
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
    for col,(label,value) in zip(cols,[('Partidas únicas',q.game.nunique()),('Tempos únicos',len(q)),('Eventos',int(q.events.sum())),('Horas com YOLO',f'{q.covered_sec.sum()/3600:.1f}')]): col.metric(label,value)
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
        columns=st.columns(4); config=result['config']
        short=columns[0].slider('Cena máxima (s)',1,20,int(config['short']))
        zero=columns[1].slider('Fração de zeros',0.,1.,float(config['zero']),.05)
        cluster=columns[2].selectbox('Cenas qualificadas em ±10 s',[1,2,3],index=int(config['cluster'])-1)
        preceding=columns[3].checkbox('Exigir ≥6 jogadores antes',value=False)
        window_columns = st.columns(2)
        before = window_columns[0].number_input('Tempo antes do início da cena (s)', min_value=0,
                                                value=20, step=1, key='simulator_before')
        after = window_columns[1].number_input('Tempo depois do início da cena (s)', min_value=0,
                                               value=25, step=1, key='simulator_after')
        st.caption(f'Intervalo de análise: início da cena − {before} s até início da cena + {after} s. '
                   'Os limites respeitam a duração analisada do vídeo; intervalos sobrepostos são unidos.')
        if before + after == 0:
            st.warning('Defina um tempo maior que zero em pelo menos um dos lados para gerar intervalos de análise.')
            return
        summary, grouped, clips, csv_bytes = cached_simulation(result['records'], token, short, zero, cluster, preceding,
                                                              before, after)
        st.dataframe(summary,hide_index=True,use_container_width=True)
        st.caption('Recall: instante de evento-alvo dentro do intervalo. Cobertura: união dos trechos / duração. Precisão: propostas com ao menos um alvo. Economia monetária depende da estratégia de envio.')
        labels = sorted({label for record in result['records'].values() for label in record['events'].label.dropna()})
        selected_labels = st.multiselect('Tipos de eventos exibidos', labels, default=[x for x in TARGETS if x in labels],
            format_func=lambda x: EVENT_NAMES.get(x, x), key='simulator_events')
        st.caption('O filtro altera os eventos do gráfico, a comparação por tipo e a tabela abaixo. '
                   'Os trechos continuam sendo gerados pela regra; as métricas gerais acima usam os eventos-alvo do estudo.')
        filtered = grouped[grouped.label.isin(selected_labels)].copy()
        if len(filtered):
            filtered['evento'] = filtered.label.map(lambda x: EVENT_NAMES.get(x,x))
            chart = px.bar(filtered,x='evento',y='recall',color='split',barmode='group',hover_data=['hits','events'],
                           labels={'recall':'Eventos capturados', 'evento':'Evento', 'split':'Conjunto'},
                           title='Captura por tipo de evento — todos os vídeos')
            chart.update_yaxes(tickformat='.0%', range=[0,1])
            st.plotly_chart(chart,use_container_width=True)
        key=st.selectbox('Inspecionar propostas no vídeo',list(result['records']))
        r = result['records'][key]
        proposals = clips[clips.video_id.eq(key)].copy()
        config_now = dict(short=short, zero=zero, cluster=cluster, preceding=preceding)
        st.info(f'Regra atual: cena de até {short} s, pelo menos {zero:.0%} das amostras sem jogadores '
                f'e no mínimo 3 amostras YOLO. Exige {cluster} cena(s) qualificada(s) em ±10 s '
                '(incluindo a própria cena). '
                + ('Também exige média de pelo menos 6 jogadores nos 15 s anteriores. ' if preceding else '')
                + f'Cada cena aprovada captura {before} s antes e {after} s depois de seu início; trechos sobrepostos são unidos.')
        show_cuts = st.checkbox('Mostrar linhas dos cortes de câmera', value=True)
        timeline, scenes, events = simulator_timeline(r, proposals, selected_labels, config_now, show_cuts)
        cols = st.columns(4)
        cols[0].metric('Cenas que acionam a regra', int(scenes.selected.sum()))
        cols[1].metric('Trechos selecionados', len(proposals))
        cols[2].metric('Tempo selecionado', f'{proposals.duration_sec.sum()/60:.1f} min')
        cols[3].metric('Eventos filtrados capturados', f'{int(events.captured.sum())} / {len(events)}')
        st.plotly_chart(timeline,use_container_width=True)
        st.caption('Cada ponto representa uma cena: 100% significa que todas as amostras YOLO ficaram sem jogadores; '
                   '0% significa que nenhuma ficou sem jogadores. Azul indica cenas que acionam a regra. '
                   'As divisões na faixa de cenas são os cortes. Verde indica os trechos capturados. '
                   'Losangos verdes são eventos dentro dos trechos; X vermelhos são eventos fora. '
                   'Cenas sem amostras não têm ponto e não acionam a regra. Use o zoom para inspecionar cortes próximos.')
        if not selected_labels:
            st.info('Nenhum tipo de evento selecionado. Selecione, por exemplo, Gol e Escanteio para inspecionar sua captura.')
        elif events.empty:
            st.info('Este vídeo não tem eventos dos tipos selecionados.')
        if proposals.empty:
            st.info('Nenhum trecho atende à regra atual neste vídeo.')
        tabs = st.tabs(['Eventos capturados e perdidos', 'Trechos selecionados', 'Cenas que acionam a regra'])
        with tabs[0]:
            table = events[['label','time_sec','captured','proposal']].copy()
            table['label'] = table.label.map(lambda x: EVENT_NAMES.get(x,x))
            table['captured'] = table.captured.map({True:'Capturado', False:'Fora dos trechos'})
            st.dataframe(table.rename(columns={'label':'Evento','time_sec':'Instante (s)',
                'captured':'Resultado','proposal':'Trecho'}),hide_index=True,use_container_width=True)
        with tabs[1]:
            table = proposals[['start_sec','end_sec','duration_sec']].copy()
            table.insert(0, 'Trecho', range(1,len(table)+1))
            st.dataframe(table.rename(columns={'start_sec':'Início (s)','end_sec':'Fim (s)',
                'duration_sec':'Duração (s)'}),hide_index=True,use_container_width=True)
        with tabs[2]:
            st.dataframe(scenes.loc[scenes.selected, ['scene_id','start_sec','duration_sec','zero_fraction','size','previous_players']]
                .rename(columns={'scene_id':'Cena','start_sec':'Início (s)','duration_sec':'Duração (s)',
                    'zero_fraction':'Fração de zeros','size':'Amostras YOLO','previous_players':'Média de jogadores antes'}),
                hide_index=True,use_container_width=True)
        st.download_button('Exportar candidatos desta configuração',csv_bytes,file_name='candidatos_llm.csv')
        st.caption(f'Candidatos recuperam {before} s antes e {after} s depois do início de cena. Intervalos sobrepostos são unidos. Propostas longas precisam ser segmentadas antes do envio.')
