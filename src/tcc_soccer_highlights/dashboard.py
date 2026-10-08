"""Painel Streamlit/Plotly para explorar os Excels gerados pelo pipeline."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from plotly.subplots import make_subplots
from tcc_soccer_highlights.analysis_store import read_workbook, source_signature

st.set_page_config(page_title="TCC Soccer Highlights", layout="wide")
OUTPUT_ROOT = Path("analysis_output")


@st.cache_resource(show_spinner=False, max_entries=512)
def load_one_workbook(path_text: str, stamp: tuple, cache_text: str):
    del stamp
    return read_workbook(Path(path_text), Path(cache_text))


@st.cache_resource(show_spinner="Carregando análises...", max_entries=4)
def load_workbooks(root_text: str, signature: tuple):
    root = Path(root_text)
    items = {}
    for path_text, mtime, size in signature:
        path = Path(path_text)
        try:
            sheets = load_one_workbook(path_text, (mtime, size), str(root / '.dashboard_cache'))
            meta = sheets.get("metadata", pd.DataFrame()).iloc[0].to_dict()
            key = str(meta.get("video_id") or path.relative_to(root))
            items[key] = {"path": path, "meta": meta, **sheets}
        except Exception as exc:
            items[str(path)] = {"path": path, "error": str(exc)}
    return items


def timeline_chart(data: dict, metrics: list[str], event_labels: list[str]):
    samples = data.get("samples", pd.DataFrame())
    events = data.get("events", pd.DataFrame())
    scenes = data.get("scenes", pd.DataFrame())
    fig = make_subplots(rows=2, cols=1, shared_xaxes=True, row_heights=[0.78, 0.22], vertical_spacing=0.05)
    for metric in metrics:
        if metric in samples:
            fig.add_trace(go.Scatter(x=samples.time_sec, y=samples[metric], mode="lines", name=metric), row=1, col=1)
    filtered_events = events[events["label"].isin(event_labels)] if event_labels and not events.empty else events
    for event in filtered_events.itertuples():
        fig.add_vline(x=event.time_sec, line_dash="dash", line_color="crimson", opacity=.55, row="all", col=1)
        fig.add_annotation(x=event.time_sec, y=1, yref="paper", text=str(event.label), textangle=-90,
                           showarrow=False, font=dict(size=9, color="crimson"))
    for scene in scenes.itertuples():
        fig.add_trace(go.Bar(x=[scene.duration_sec], y=["cenas"], base=[scene.start_sec], orientation="h",
                             name=f"Cena {scene.scene_id}", showlegend=False,
                             hovertemplate=f"Cena {scene.scene_id}<br>{scene.start_sec:.2f}s–{scene.end_sec:.2f}s<extra></extra>"), row=2, col=1)
    fig.update_layout(height=650, barmode="stack", hovermode="x unified", title="Timeline: YOLO, TransNetV2 e eventos reais")
    fig.update_xaxes(title="Tempo no vídeo (s)", row=2, col=1)
    return fig


def individual_view(data: dict):
    meta, samples, events = data["meta"], data.get("samples", pd.DataFrame()), data.get("events", pd.DataFrame())
    cols = st.columns(5)
    values = [("Duração", f"{float(meta.get('duration_sec', 0))/60:.1f} min"),
              ("Cenas", len(data.get("scenes", []))), ("Eventos reais", len(events)),
              ("Amostras YOLO", len(samples)), ("Processamento", f"{float(meta.get('processing_seconds', 0)):.0f}s")]
    for col, (label, value) in zip(cols, values):
        col.metric(label, value)
    available = [c for c in ["player_count", "ball_count", "ball_conf_max", "referee_count", "goalkeeper_count"] if c in samples]
    labels = sorted(events["label"].dropna().unique()) if not events.empty else []
    c1, c2 = st.columns([2, 1])
    metrics = c1.multiselect("Métricas", available, default=available[:3])
    selected_labels = c2.multiselect("Eventos exibidos", labels, default=labels)
    st.plotly_chart(timeline_chart(data, metrics, selected_labels), use_container_width=True)
    tabs = st.tabs(["Eventos e janelas", "Cenas", "Distribuições", "Dados"])
    with tabs[0]:
        windows = data.get("event_windows", pd.DataFrame())
        if windows.empty:
            st.info("Sem janelas calculadas (é necessário executar o YOLO e possuir Labels-v2.json).")
        else:
            numeric = [c for c in windows.select_dtypes(include=np.number) if c not in {"event_time_sec", "sample_count", "window_sec"}]
            metric = st.selectbox("Comparar eventos pela métrica", numeric)
            grouped = windows.groupby("label", as_index=False)[metric].mean().sort_values(metric, ascending=False)
            st.plotly_chart(px.bar(grouped, x="label", y=metric, title="Média por tipo de evento real"), use_container_width=True)
            st.dataframe(windows, use_container_width=True, hide_index=True)
    with tabs[1]:
        scene_summary = data.get("scene_summary", pd.DataFrame())
        st.dataframe(scene_summary, use_container_width=True, hide_index=True)
    with tabs[2]:
        if available:
            melted = samples.melt(id_vars=["near_event"] if "near_event" in samples else None,
                                  value_vars=available, var_name="métrica", value_name="valor")
            color = "near_event" if "near_event" in samples else None
            st.plotly_chart(px.box(melted, x="métrica", y="valor", color=color, points=False,
                                   title="Distribuição perto e longe de eventos"), use_container_width=True)
    with tabs[3]:
        st.dataframe(samples, use_container_width=True, hide_index=True)
        with open(data["path"], "rb") as handle:
            st.download_button("Baixar este Excel", handle, file_name=data["path"].name)


def comparison_view(selected: list[str], items: dict):
    metas, events, windows = [], [], []
    for key in selected:
        data = items[key]
        metas.append(data["meta"])
        for name, target in [("events", events), ("event_windows", windows)]:
            frame = data.get(name, pd.DataFrame()).copy()
            if not frame.empty:
                frame["video_id"] = key
                target.append(frame)
    meta_df = pd.DataFrame(metas)
    st.subheader("Visão comparativa")
    st.dataframe(meta_df, use_container_width=True, hide_index=True)
    if events:
        event_df = pd.concat(events, ignore_index=True)
        counts = event_df.groupby(["video_id", "label"]).size().reset_index(name="quantidade")
        st.plotly_chart(px.bar(counts, x="video_id", y="quantidade", color="label", title="Eventos reais por vídeo"), use_container_width=True)
    if windows:
        window_df = pd.concat(windows, ignore_index=True)
        numeric = [c for c in window_df.select_dtypes(include=np.number) if c not in {"event_time_sec", "sample_count", "window_sec"}]
        if numeric:
            metric = st.selectbox("Métrica comparativa", numeric)
            grouped = window_df.groupby(["video_id", "label"], as_index=False)[metric].mean()
            st.plotly_chart(px.bar(grouped, x="label", y=metric, color="video_id", barmode="group"), use_container_width=True)
            st.plotly_chart(px.box(window_df, x="label", y=metric, color="video_id", points=False), use_container_width=True)


st.title("Análise de melhores momentos no futebol")
root_text = st.sidebar.text_input("Pasta das análises", str(OUTPUT_ROOT))
root = Path(root_text)
snapshot_key = str(root.resolve())
if st.sidebar.button("Atualizar arquivos concluídos"):
    st.session_state.pop('analysis_snapshot', None)
    st.rerun()
snapshot = st.session_state.get('analysis_snapshot')
if snapshot is None or snapshot['root'] != snapshot_key:
    snapshot = dict(root=snapshot_key, signature=source_signature(root))
    st.session_state['analysis_snapshot'] = snapshot
signature = snapshot['signature']
items = {k: v for k, v in load_workbooks(root_text, signature).items() if "error" not in v}
if not items:
    st.warning("Nenhum Excel de análise encontrado. Execute primeiro o pipeline em lote.")
    st.stop()
mode = st.sidebar.radio("Modo", ["Vídeo individual", "Comparar vídeos", "Eventos, cortes e YOLO", "Simulador de regras", "Relatório do estudo"])
names = list(items)
if mode == "Vídeo individual":
    selected = st.sidebar.selectbox("Vídeo", names)
    st.caption(selected)
    individual_view(items[selected])
elif mode == "Comparar vídeos":
    selected = st.sidebar.multiselect("Vídeos", names, default=names[: min(3, len(names))])
    if selected:
        comparison_view(selected, items)
else:
    from tcc_soccer_highlights.study_dashboard import render
    render(mode, items, (snapshot_key, signature))
