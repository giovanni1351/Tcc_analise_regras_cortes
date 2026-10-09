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
