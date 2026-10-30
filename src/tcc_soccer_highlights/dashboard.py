"""Painel Streamlit/Plotly para explorar os Excels gerados pelo pipeline."""

from __future__ import annotations

from importlib import reload
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import streamlit as st
from tcc_soccer_highlights.dashboard_charts import timeline_chart
from tcc_soccer_highlights import analysis_store

# Sessões já abertas podem manter a versão anterior deste módulo após o rerun.
if not hasattr(analysis_store, 'read_metadata_index'):
    reload(analysis_store)
read_workbook = analysis_store.read_workbook
read_metadata_index = analysis_store.read_metadata_index
source_signature = analysis_store.source_signature

st.set_page_config(page_title="TCC Soccer Highlights", layout="wide")
OUTPUT_ROOT = Path("analysis_output")


@st.cache_resource(show_spinner=False, max_entries=8)
def load_one_workbook(path_text: str, stamp: tuple, cache_text: str, sheet_names=None):
    del stamp
    return read_workbook(Path(path_text), Path(cache_text), sheet_names=sheet_names)


@st.cache_resource(show_spinner="Carregando análises para o estudo...", max_entries=1)
def load_workbooks(root_text: str, signature: tuple):
    root = Path(root_text)
    items = {}
    for path_text, mtime, size in signature:
        path = Path(path_text)
        try:
            sheets = load_one_workbook(path_text, (mtime, size), str(root / '.dashboard_cache'),
                                       ('metadata', 'samples', 'scenes', 'events'))
            meta = sheets.get("metadata", pd.DataFrame()).iloc[0].to_dict()
            key = str(meta.get("video_id") or path.relative_to(root))
            items[key] = {"path": path, "meta": meta, **sheets}
        except Exception as exc:
            items[str(path)] = {"path": path, "error": str(exc)}
    return items


@st.cache_resource(show_spinner="Carregando lista de vídeos...", max_entries=1)
def load_index(root_text: str, signature: tuple):
    return read_metadata_index(Path(root_text), signature)


def load_selected(data, signature, root):
    stamps = {path: (mtime, size) for path, mtime, size in signature}
    path_text = str(data['path'])
    sheets = load_one_workbook(path_text, stamps[path_text], str(root / '.dashboard_cache'))
    return {**data, **sheets, 'meta': sheets['metadata'].iloc[0].to_dict()}


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
mode = st.sidebar.radio("Modo", ["Vídeo individual", "Comparar vídeos", "Eventos, cortes e YOLO", "Simulador de regras", "Resumo das regras salvas", "Relatório do estudo"], key='dashboard_mode')
if mode == 'Resumo das regras salvas':
    from tcc_soccer_highlights.saved_rules_dashboard import render_saved_summary
    from tcc_soccer_highlights.study_dashboard import cached_study

    def load_current_study():
        current_items = {k: v for k, v in load_workbooks(root_text, signature).items() if 'error' not in v}
        if not current_items:
            raise ValueError('Nenhuma análise disponível para reavaliar as regras.')
        return cached_study(current_items, (snapshot_key, signature))

    render_saved_summary(load_current_study, (snapshot_key, signature))
    st.stop()
items = {k: v for k, v in load_index(root_text, signature).items() if "error" not in v}
if not items:
    st.warning("Nenhum Excel de análise encontrado. Execute primeiro o pipeline em lote.")
    st.stop()
names = list(items)
if mode == "Vídeo individual":
    selected = st.sidebar.selectbox("Vídeo", names)
    st.caption(selected)
    individual_view(load_selected(items[selected], signature, root))
elif mode == "Comparar vídeos":
    selected = st.sidebar.multiselect("Vídeos", names, default=names[: min(3, len(names))])
    if selected:
        comparison_view(selected, {key: load_selected(items[key], signature, root) for key in selected})
else:
    if mode != 'Relatório do estudo':
        items = {k: v for k, v in load_workbooks(root_text, signature).items() if 'error' not in v}
    from tcc_soccer_highlights.study_dashboard import render
    render(mode, items, (snapshot_key, signature))
