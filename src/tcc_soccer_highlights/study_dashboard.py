"""Páginas exploratórias do estudo de seleção de candidatos."""
from pathlib import Path

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st

from tcc_soccer_highlights.highlight_study import TARGETS, evaluate, scores, study, resolution_study


@st.cache_resource(show_spinner='Calculando estudo dos vídeos concluídos...', max_entries=2)
def cached_study(_items, token):
    return study(_items)


@st.cache_resource(show_spinner='Comparando resoluções...', max_entries=2)
def cached_resolution(_items, token, config):
    return resolution_study(_items, config)


@st.cache_data(show_spinner=False, max_entries=128)
def cached_simulation(_records, token, short, zero, cluster, preceding):
    evaluation, clips = evaluate(_records, dict(short=short, zero=zero, cluster=cluster, preceding=preceding))
    summary = pd.DataFrame([scores(evaluation, clips, _records, s) for s in ['treino', 'teste']])
    summary['reducao_temporal'] = 1-summary.coverage
    grouped = evaluation.groupby(['split', 'label'])[['events', 'hits']].sum().reset_index()
    grouped['recall'] = grouped.hits/grouped.events
    return summary, grouped, clips, clips.to_csv(index=False).encode('utf-8-sig')


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
        summary, grouped, clips, csv_bytes = cached_simulation(result['records'], token, short, zero, cluster, preceding)
        st.dataframe(summary,hide_index=True,use_container_width=True)
        st.caption('Recall: instante de evento-alvo dentro do intervalo. Cobertura: união dos trechos / duração. Precisão: propostas com ao menos um alvo. Economia monetária depende da estratégia de envio.')
        st.plotly_chart(px.bar(grouped,x='label',y='recall',color='split',barmode='group',hover_data=['hits','events']),use_container_width=True)
        st.write('Eventos-alvo: '+', '.join(TARGETS))
        key=st.selectbox('Inspecionar propostas no vídeo',list(result['records']))
        r=result['records'][key]; features=r['features']; timeline=go.Figure()
        timeline.add_trace(go.Scatter(x=features.start_sec,y=features.zero_fraction,mode='markers',name='Fração de zeros',customdata=features.duration_sec,hovertemplate='t=%{x:.1f}s<br>zeros=%{y:.2f}<br>cena=%{customdata:.1f}s'))
        shapes = [dict(type='rect', xref='x', yref='paper', x0=c.start_sec, x1=c.end_sec,
                       y0=0, y1=1, fillcolor='green', opacity=.12, line=dict(width=0))
                  for c in clips[clips.video_id.eq(key)].itertuples()]
        annotations = []
        for e in r['events'][r['events'].label.isin(TARGETS)].itertuples():
            shapes.append(dict(type='line', xref='x', yref='paper', x0=e.time_sec, x1=e.time_sec,
                               y0=0, y1=1, line=dict(dash='dash', color='red')))
            annotations.append(dict(x=e.time_sec, y=1, xref='x', yref='paper', text=e.label, showarrow=False))
        timeline.update_layout(xaxis_title='Tempo no vídeo (s)',yaxis_title='Fração de zeros',height=450,
                               shapes=shapes, annotations=annotations)
        st.plotly_chart(timeline,use_container_width=True)
        st.dataframe(clips[clips.video_id.eq(key)],hide_index=True,use_container_width=True)
        st.download_button('Exportar candidatos desta configuração',csv_bytes,file_name='candidatos_llm.csv')
        st.caption('Candidatos recuperam 20 s antes e 25 s depois do início de cena. Intervalos sobrepostos são unidos. Propostas longas precisam ser segmentadas antes do envio.')
