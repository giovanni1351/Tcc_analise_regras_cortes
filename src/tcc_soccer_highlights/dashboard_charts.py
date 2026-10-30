"""Gráficos do painel, construídos em lote para evitar atualizações quadráticas."""
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots


def timeline_chart(data: dict, metrics: list[str], event_labels: list[str]):
    samples = data.get('samples', pd.DataFrame())
    events = data.get('events', pd.DataFrame())
    scenes = data.get('scenes', pd.DataFrame())
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True,
                        row_heights=[.78, .22], vertical_spacing=.05)
    for metric in metrics:
        if metric in samples:
            fig.add_trace(go.Scatter(x=samples.time_sec, y=samples[metric], mode='lines', name=metric), row=1, col=1)
    filtered = events[events.label.isin(event_labels)] if event_labels and not events.empty else events
    shapes, annotations = [], []
    for event in filtered.itertuples():
        for xref, yref in [('x', 'y domain'), ('x2', 'y2 domain')]:
            shapes.append(dict(type='line', x0=event.time_sec, x1=event.time_sec, y0=0, y1=1,
                               xref=xref, yref=yref, line=dict(dash='dash', color='crimson'), opacity=.55))
        annotations.append(dict(x=event.time_sec, y=1, xref='x', yref='paper', text=str(event.label),
                                textangle=-90, showarrow=False, font=dict(size=9, color='crimson')))
    if not scenes.empty:
        fig.add_trace(go.Bar(x=scenes.duration_sec, y=['cenas'] * len(scenes), base=scenes.start_sec,
                            orientation='h', name='Cenas', showlegend=False,
                            marker_color=['#94a3b8' if i % 2 == 0 else '#cbd5e1' for i in range(len(scenes))],
                            customdata=scenes[['scene_id', 'start_sec', 'end_sec']].to_numpy(),
                            hovertemplate='Cena %{customdata[0]}<br>%{customdata[1]:.2f}s–%{customdata[2]:.2f}s<extra></extra>'),
                      row=2, col=1)
    fig.update_layout(height=650, barmode='stack', hovermode='x unified',
                      title='Timeline: YOLO, TransNetV2 e eventos reais', shapes=shapes, annotations=annotations)
    fig.update_xaxes(title='Tempo no vídeo (s)', row=2, col=1)
    return fig
