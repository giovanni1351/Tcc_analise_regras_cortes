"""Verificação integrada das páginas com os arquivos reais disponíveis."""
from streamlit.testing.v1 import AppTest
from pathlib import Path
from time import perf_counter

def timed_run(action, label):
    start=perf_counter(); action()
    assert not app.exception, [x.message for x in app.exception]
    print(f'{label}: OK ({perf_counter()-start:.3f}s)',flush=True)

app=AppTest.from_file(str(Path(__file__).resolve().parents[1]/'src/tcc_soccer_highlights/dashboard.py'),default_timeout=300)
timed_run(app.run,'Vídeo individual / primeira carga')
for mode in ['Comparar vídeos','Eventos, cortes e YOLO','Simulador de regras','Relatório do estudo']:
    timed_run(lambda: app.sidebar.radio[0].set_value(mode).run(),mode)
timed_run(lambda: app.sidebar.radio[0].set_value('Simulador de regras').run(),'Simulador / retorno')
defaults = {name: app.session_state[f'simulator_{name}']
            for name in ['short', 'zero', 'cluster', 'preceding', 'before', 'after']}
default_labels = app.multiselect(key='simulator_events').value
for value in [8,10,12,8]:
    timed_run(lambda: app.slider[0].set_value(value).run(),f'Cena máxima {value}s')
timed_run(lambda: app.multiselect(key='simulator_events').set_value(['Goal', 'Corner']).run(),
          'Simulador / gols e escanteios')
timed_run(lambda: app.multiselect(key='simulator_events').set_value([]).run(),
          'Simulador / nenhum evento')
summary = app.dataframe[0].value
assert summary.events.eq(0).all()
assert summary.hits.eq(0).all()
assert summary.recall.isna().all()
timed_run(lambda: app.number_input(key='simulator_before').set_value(5).run(),
          'Simulador / 5 segundos antes')
timed_run(lambda: app.number_input(key='simulator_after').set_value(10).run(),
          'Simulador / 10 segundos depois')
timed_run(lambda: app.number_input(key='simulator_before').set_value(0).run(),
          'Simulador / somente depois')
timed_run(lambda: app.number_input(key='simulator_after').set_value(0).run(),
          'Simulador / intervalo vazio')
assert any('Defina um tempo maior que zero' in warning.value for warning in app.warning)
timed_run(lambda: app.number_input(key='simulator_before').set_value(20).run(),
          'Simulador / recuperar intervalo válido')

app.slider(key='simulator_short').set_value(defaults['short'])
app.slider(key='simulator_zero').set_value(defaults['zero'])
app.selectbox(key='simulator_cluster').set_value(defaults['cluster'])
app.checkbox(key='simulator_preceding').set_value(defaults['preceding'])
app.number_input(key='simulator_before').set_value(defaults['before'])
app.number_input(key='simulator_after').set_value(defaults['after'])
timed_run(lambda: app.multiselect(key='simulator_events').set_value(default_labels).run(),
          'Otimizador / restaurar configuração e eventos padrão')
initial_summary = app.dataframe[0].value.copy()
timed_run(lambda: app.button(key='optimize_rules').click().run(),
          'Otimizador / buscar e aplicar parâmetros')
result = app.session_state['optimizer_result'][1]
assert result.feasible
assert result.target_recall == .9
assert result.best['recall'] >= .9
if result.baseline['recall'] >= .9:
    assert result.best['reduction'] >= result.baseline['reduction'] - 1e-12
for name, value in result.config.items():
    assert app.session_state[f'simulator_{name}'] == value
summary = next(d.value for d in app.dataframe if 'coverage' in d.value.columns)
train = summary.set_index('split').loc['treino']
assert abs(train.recall - result.best['recall']) < 1e-10
assert abs(1 - train.coverage - result.best['reduction']) < 1e-10
print(f"Otimizador: {result.evaluated_combinations} combinações; "
      f"recall {result.baseline['recall']:.2%} -> {result.best['recall']:.2%}; "
      f"redução {result.baseline['reduction']:.2%} -> {result.best['reduction']:.2%}", flush=True)
print(f'Parâmetros: {result.config}', flush=True)
print(f'Antes:\n{initial_summary.to_string(index=False)}\nDepois:\n{summary.to_string(index=False)}', flush=True)
