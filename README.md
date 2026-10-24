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

O projeto fixa o PyTorch CUDA 12.6, que mantém suporte à GTX 1050 Ti (Pascal).
Confirme a GPU executando uma operação CUDA real:

```powershell
uv run python -c "import torch; print(torch.cuda.get_device_name(0)); print(torch.ones(1, device='cuda').sum().item())"
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

## Download, inferência e envio automático ao GitHub

Para processar os dois tempos em 224p sem acumular os vídeos:

```powershell
uv run python -m tcc_soccer_highlights.streaming_analysis --model best.pt
```

O fluxo baixa o próximo vídeo enquanto TransNetV2 e YOLO analisam o anterior.
Mantém no máximo dois vídeos temporários em `.pipeline_state/videos/`. Cada análise
gera um XLSX em `analysis_output/`, faz um commit apenas desse arquivo e envia para
`origin/main`. O vídeo temporário é removido; a planilha permanece localmente e no
GitHub. Os vídeos de outras pastas, como `videos/`, não são removidos.

Para usar outro disco nos downloads temporários:

```powershell
uv run python -m tcc_soccer_highlights.streaming_analysis --download-root D:\Tcc_analise_regras_cortes\downloads
```

A escolha fica salva em `.pipeline_state/settings.json` e é reutilizada nos próximos
comandos, inclusive no `--dry-run`. A pasta precisa ser exclusiva deste pipeline.
Os XLSX continuam em `analysis_output/` no projeto; os checkpoints e o repositório
Git isolado continuam em `.pipeline_state/`. Para solicitar uma parada, o arquivo
`STOP` continua sendo criado em `.pipeline_state/STOP` no projeto.

O envio usa um repositório Git isolado em `.pipeline_state/publisher.git`: alterações
locais, arquivos já preparados para commit e conflitos de merge do projeto não entram
nesses commits. O branch remoto deve existir e a autenticação Git deve permitir push.
Não há force push. Para mudar o destino, use `--remote origin --branch nome-do-branch`.
Não execute duas instâncias usando o mesmo diretório de estado.

Por padrão são usados `train`, `valid` e `test`, stride 5 e lotes de 16 frames.
O download usa o [Hugging Face, fonte atual do SoccerNet](https://www.soccer-net.org/data).
Solicite acesso ao [dataset dos vídeos](https://huggingface.co/datasets/SoccerNet/SoccerNet_raw_HQ)
e faça login localmente com uma conta aprovada:

```powershell
uv run hf auth login
```

Também aceita `HF_TOKEN` no ambiente. O token não vai para os commits. Os vídeos
são baixados diretamente ao temporário do pipeline, sem uma cópia adicional no
cache do Hugging Face. As anotações vêm de `SoccerNet/SN-Labels`.
Para conferir a quantidade de trabalho sem baixar nem publicar:

```powershell
uv run python -m tcc_soccer_highlights.streaming_analysis --dry-run
```

Para limitar o lote ou escolher resoluções/conjuntos:

```powershell
uv run python -m tcc_soccer_highlights.streaming_analysis --limit 2 --splits train --files 1_224p.mkv 2_224p.mkv
```

Análises completas já existentes são preservadas e puladas. Arquivos incompletos ou
corrompidos são processados novamente. Se o push falhar, o pipeline para e preserva
o XLSX; execute o mesmo comando para reenviar sem repetir a inferência concluída.
Downloads temporários são descartados também em falhas e interrupções normais.
Se o computador desligar abruptamente, podem restar até dois vídeos, reutilizáveis
como espaço temporário na próxima execução. Apenas pequenos arquivos de anotações,
checkpoints e objetos Git permanecem em `.pipeline_state/`.

Para solicitar uma parada após salvar o vídeo em processamento (inclusive quando
o processo foi iniciado em segundo plano), crie o arquivo de sinalização:

```powershell
New-Item -ItemType File -Force .pipeline_state/STOP
```

O próximo início remove essa sinalização e retoma os trabalhos pendentes.

A seleção automática de dispositivo verifica uma operação real na GPU. Caso o
PyTorch instalado não suporte a placa, usa CPU e registra o motivo. Use
`--device cpu` para escolher CPU explicitamente, ou `--device cuda` para exigir GPU.
`--max-seconds 60` permite testes parciais, gravados e publicados separadamente em
`analysis_output/pipeline_tests/`, sem substituir análises completas.

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

### Busca automática de parâmetros

Em **Simulador de regras**, selecione os tipos de eventos e clique em
**Encontrar melhor combinação**. Uma busca exata em grade ajusta os seis controles:
duração máxima da cena, fração de zeros, quantidade de cenas agrupadas, exigência
de jogadores antes e janelas temporais antes/depois. A melhor configuração
encontrada é aplicada automaticamente, atualizando métricas, gráficos e candidatos.

A busca usa somente os vídeos de **treino**, com recall calculado sobre os eventos
selecionados e redução temporal calculada sobre a duração total desse conjunto,
incluindo vídeos sem esses eventos. O teste permanece separado para avaliação.
A busca maximiza a **redução temporal**, com a restrição obrigatória
`recall >= recall mínimo solicitado nesta execução`.
O mínimo solicitado é **90%** por padrão e pode ser ajustado em **Opções da busca**.
O valor escolhido na tela é respeitado mesmo quando o recall atual é maior:
baixar a meta de 90% para 80% permite buscar maior redução de tempo com recall
a partir de 80%; aumentar a meta exige capturar mais eventos. Depois de alterar
o valor, clique novamente em **Encontrar melhor combinação**. O resultado pode
superar o mínimo ou repetir uma configuração quando ela atende melhor às duas
metas. Se a configuração inicial já atende à meta, ela
participa da seleção, e a redução temporal também não piora (salvo arredondamento
numérico). Se o recall inicial está abaixo da meta, alcançá-la pode exigir mais
tempo de vídeo. Se nenhuma combinação atende à meta, os controles são mantidos
e a tela informa o recall máximo alcançável nos limites da busca.

O espaço de busca segue os controles: cenas de 1–20 s, fração de zeros de 0–1
em passos de 0,05, agrupamento de 1–3 cenas, exigência anterior ligada/desligada
e janelas inteiras de 0 até o limite escolhido (120 s por lado por padrão),
com soma positiva. Esse limite deve incluir as janelas atuais e pode ser
ampliado até 600 s por lado. Todas as 2.520 regras e todos os pares de janelas
são considerados: com limite de 120 s, são **36.892.800 combinações**.
O cálculo vetorizado usa histogramas acumulados das distâncias entre eventos
e cenas para o recall, e união dos intervalos para a duração, compartilhando
o núcleo de seleção de cenas com o simulador. Não há sorteios nem pesos
que permitam violar a restrição. Entre durações iguais, prefere maior recall.

O resultado maximiza a redução **dentro dessa grade finita e da restrição no
treino**, com tolerância numérica de 1 ns ao comparar durações. Isso não garante
o mesmo recall no teste ou em partidas novas. A tela mostra métricas antes/depois,
evolução da busca e um CSV com a melhor janela viável de cada regra e a
configuração inicial. O botão **Restaurar parâmetros anteriores** desfaz a aplicação.
As anotações orientam a escolha dos parâmetros no
treino, mas a geração de trechos continua usando apenas cortes e sinais do YOLO.
O botão não altera a configuração do relatório PDF nem grava um preset em disco;
os parâmetros aplicados ficam na sessão atual do simulador.

### Primeiro tempo em 720p e baixa resolução

O simulador inclui **Comparação de resoluções — primeiro tempo**, usando a regra
atual e os tipos de eventos selecionados. Compara apenas partidas que possuem
as duas análises, em 720p e 224p (ou 240p, se disponível). Os arquivos atuais
de baixa resolução são 224p; a tela identifica a resolução real.

As duas versões usam a mesma duração analisada em comum e as mesmas anotações
de referência do SoccerNet, obtidas do Excel 720p. Os sinais de YOLO e as cenas
são recortados a esse período antes da avaliação. Análises parciais são
identificadas pela duração comum; segundos tempos e partidas sem par ficam fora.

As tabelas mostram recall, eventos cobertos e perdidos, redução temporal,
precisão das propostas, diferenças em pontos percentuais e resultados por tipo
de evento e por partida. Os totais são ponderados por eventos, duração e
propostas, conforme cada métrica. Há exportação CSV por partida com os parâmetros
utilizados. O pareamento assume que o instante zero das duas versões representa
o mesmo conteúdo. Alterações manuais ou aplicadas pela busca recalculam a comparação.

### Regra alternativa: queda de jogadores após campo aberto

Em **Regra para analisar**, a opção original continua disponível junto de
**Nova: queda de jogadores após campo aberto**. A nova regra busca uma mudança
de enquadramento: exige uma média anterior de pelo menos 6 jogadores detectados
nos 15 s anteriores e uma queda de pelo menos 65% na média da cena. Ambos os
limiares podem ser alterados manualmente. Exemplo: de 10 para 3 detecções é uma
queda de 70%, mesmo sem nenhuma amostra com zero jogadores.

Também se aplicam a duração máxima da cena, as três amostras mínimas, a quantidade
de cenas qualificadas em ±10 s e as janelas antes/depois. A fração de zeros e a
opção fixa de exigir ≥6 jogadores anteriores pertencem somente à regra original;
ficam desabilitadas quando a alternativa está selecionada. A opção nova usa seu
próprio mínimo anterior. As anotações não participam da geração dos trechos.

O pseudocódigo na página acompanha os controles. A tabela entre regras compara
recall, eventos perdidos, redução temporal e precisão das propostas nas mesmas
partidas, janelas e tipos de evento. A regra escolhida também é usada nas demais
tabelas, exportações, timeline e comparação 720p × 224p. A busca automática já
existente permanece disponível apenas para a regra original.

A hipótese é experimental: maior recall pode decorrer de selecionar mais vídeo,
e falhas do YOLO também podem produzir quedas. A comparação apresenta os dois
resultados para avaliar essa troca, sem assumir superioridade em todos os eventos.
