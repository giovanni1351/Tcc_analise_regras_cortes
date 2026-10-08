# TCC — reconhecimento de melhores momentos no futebol

O projeto contém um pipeline em lote que cruza:

- cortes de cena do TransNetV2;
- detecções do modelo YOLO (`player`, `ball`, `referee`, `goalkeeper`);
- eventos reais do `Labels-v2.json` do SoccerNet.

Cada vídeo gera um Excel próprio em `analysis_output/`, preservando a estrutura de
pastas original. O Excel contém as abas `metadata`, `samples`, `scenes`, `events`,
`event_windows` e `scene_summary`.

## Instalação

```powershell
uv sync
```

O projeto fixa o PyTorch CUDA 12.8. Confirme a GPU com:

```powershell
uv run python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

## Teste rápido

O repositório não inclui o peso treinado do YOLO. Informe o caminho do seu `best.pt`:

```powershell
uv run python -m tcc_soccer_highlights.batch_analysis --model C:\caminho\best.pt --pattern 1_224p.mkv --limit 1 --max-seconds 60
```

## Processar todos os vídeos

```powershell
uv run python -m tcc_soccer_highlights.batch_analysis --model C:\caminho\best.pt --skip-existing
```

Por padrão o YOLO analisa um frame a cada 5 (`--stride 5`). Use `--stride 1` para
todos os frames, com custo muito maior. A inferência usa lotes de 16 frames na GPU;
ajuste com `--batch-size` se necessário. Para selecionar só uma versão dos jogos,
use, por exemplo, `--pattern 1_224p.mkv`. Execuções interrompidas podem continuar
com `--skip-existing`. Um `manifest.csv` registra sucessos e erros.

É possível gerar os Excels sem YOLO omitindo `--model`, ou sem TransNetV2 usando
`--skip-transnet`; isso é útil para validar rapidamente os eventos e o painel.

## Abrir o painel interativo

```powershell
uv run streamlit run src/tcc_soccer_highlights/dashboard.py
```

O painel permite escolher um vídeo ou comparar vários, filtrar eventos, inspecionar
a timeline sincronizada, comparar métricas perto/longe dos eventos reais, analisar
cenas e baixar o Excel individual.

## Estudo de eventos, cortes e seleção para a LLM

```powershell
.venv/Scripts/python.exe -m tcc_soccer_highlights.highlight_study
```

Gera `reports/highlight_study/relatorio_eventos_cortes_yolo.pdf`, o guia
`regras_e_metodologia.md`, gráficos PNG e tabelas CSV. Lê uma fotografia dos
Excels completos sem interromper o processamento em andamento. O registro de
fontes e limiares fica em `snapshot.json`.

O painel inclui páginas de eventos/cortes/YOLO, simulador de regras e download
do relatório. A aba de resolução compara 224p e 720p no mesmo conteúdo e nos
mesmos timestamps. Use **Atualizar arquivos concluídos** para recarregar o painel;
gere o PDF novamente para atualizar o documento.

O estudo evita duplicatas por resolução, mantém partidas separadas entre treino
e teste e mede recall de eventos, duração selecionada e precisão de propostas.
Zeros do YOLO são indícios de câmera fora do domínio de treinamento (closes e
outros ângulos), sem identificar automaticamente replays. As anotações são
usadas somente na avaliação: `clips.csv` contém candidatos gerados apenas com
TransNet e YOLO. A redução temporal não equivale a economia monetária medida.

### Desempenho do painel

Na primeira leitura de cada Excel, o painel cria um cache Parquet em
`analysis_output/.dashboard_cache/`. Nas próximas aberturas, reaproveita esse
cache e converte apenas arquivos novos ou modificados. A primeira conversão
ainda depende da leitura dos Excels; não há reexecução dos modelos.

Enquanto você ajusta os parâmetros, a amostra permanece fixa em memória.
**Atualizar arquivos concluídos** incorpora novos resultados do processamento.
Os cálculos do simulador são vetorizados e configurações já avaliadas ficam em
cache. O cache Parquet é regenerável e deve ficar fora do versionamento.
