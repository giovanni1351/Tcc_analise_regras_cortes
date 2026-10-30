# Pré-seleção de melhores momentos no futebol por regras de cena e detecções de jogadores

**Resumo para o artigo — resultados exploratórios salvos em 26 de outubro de 2026**

## Resumo

Este estudo avalia um filtro temporal para reduzir o material de partidas de futebol enviado a uma etapa posterior de análise semântica. O TransNetV2 identifica mudanças de cena, e as detecções de jogadores do YOLO fornecem informações sobre o contexto visual. Quatro configurações de uma mesma regra foram comparadas em uma fotografia de 497 tempos de 249 partidas, com 13.082 anotações dos cinco tipos de evento selecionados. A configuração com cenas de até 25 s e janela de 10 s antes a 16 s depois recuperou 91,09% dos eventos em todas as partidas, com redução temporal de 32,42%. No teste, os valores foram 91,10% e 32,21%, respectivamente. Os resultados são exploratórios e medem a sobreposição temporal com anotações, não a identificação semântica do lance.

**Palavras-chave:** futebol; melhores momentos; visão computacional; seleção temporal; SoccerNet.

## 1. Método experimental

A amostra usa a maior resolução disponível por partida e tempo, sem duplicar versões do mesmo conteúdo. O estudo divide as partidas de forma determinística: aproximadamente uma a cada três partidas, em ordem de nome, compõe o teste; os dois tempos de uma partida permanecem no mesmo conjunto. A fotografia reúne aproximadamente 377,86 horas analisadas. Os eventos selecionados são falta, gol, impedimento, finalização para fora e finalização no gol; há 8.713 anotações no treino e 4.369 no teste.

Uma cena qualifica-se quando sua duração é menor ou igual ao limite configurado, possui pelo menos três amostras do YOLO e a média de jogadores detectados nos 15 s anteriores ao seu início é de pelo menos seis. As quatro configurações exigem uma cena qualificada no agrupamento de ±10 s, condição satisfeita pela própria cena. O limiar da fração de amostras sem jogadores é 0% em todas elas: portanto, não há exigência efetiva de ausência de jogadores. Para cada início de cena qualificada, gera-se uma janela com duração anterior e posterior definidas na Tabela 1; janelas sobrepostas são unidas e limitadas ao período analisado. As anotações são usadas para avaliar os trechos, não para gerá-los.

O **recall** é a proporção de eventos selecionados cujo instante está dentro de algum trecho. O **delta de avaliação é 0 s** em todos os experimentos. A **redução temporal** é um menos a duração da união dos trechos dividida pela duração analisada. A **precisão das propostas** é a proporção de trechos unidos que contêm ao menos um evento selecionado; não é precisão de classificação de eventos. As métricas agregadas usam os totais de eventos, duração e propostas, em vez da média das porcentagens por partida.

## 2. Resultados por configuração

**Tabela 1 — Parâmetros e métricas salvas (%).** As janelas são dadas em segundos antes/depois do início da cena; P é a precisão das propostas.

| Configuração salva | Cena máx. | Janela | Treino: recall / redução | Teste: recall / redução | Todas: recall / redução | P: todas |
| --- | --- | --- | --- | --- | --- | --- |
| A — boa regra | 25 s | 16 / 12 | 92,01 / 29,94 | 91,55 / 29,67 | 91,86 / 29,85 | 52,19 |
| B — redução de 35 e 89 de recall | 25 s | 8 / 16 | 89,58 / 35,20 | 89,84 / 34,86 | 89,67 / 35,09 | 48,37 |
| C — redução de 31 e 91 de recall | 25 s | 10 / 16 | 91,08 / 32,52 | 91,10 / 32,21 | 91,09 / 32,42 | 50,62 |
| D — 92 de recall e 29 de redução | 27 s | 16 / 12 | 92,22 / 29,66 | 91,97 / 29,38 | 92,13 / 29,56 | 53,19 |

<!-- pagebreak -->

## 3. Cobertura por evento no teste

**Tabela 2 — Eventos cobertos / total no teste e recall (%).** Os eventos não cobertos correspondem à diferença entre total e cobertos. As quatro configurações usam as mesmas anotações e delta 0 s.

| Evento | A: cobertos / total (%) | B: cobertos / total (%) | C: cobertos / total (%) | D: cobertos / total (%) |
| --- | --- | --- | --- | --- |
| Falta | 1.822 / 1.983 (91,88) | 1.794 / 1.983 (90,47) | 1.826 / 1.983 (92,08) | 1.830 / 1.983 (92,28) |
| Gol | 252 / 271 (92,99) | 254 / 271 (93,73) | 254 / 271 (93,73) | 253 / 271 (93,36) |
| Impedimento | 309 / 319 (96,87) | 306 / 319 (95,92) | 310 / 319 (97,18) | 309 / 319 (96,87) |
| Finalização para fora | 758 / 831 (91,22) | 745 / 831 (89,65) | 750 / 831 (90,25) | 762 / 831 (91,70) |
| Finalização no gol | 859 / 965 (89,02) | 826 / 965 (85,60) | 840 / 965 (87,05) | 864 / 965 (89,53) |

Na configuração C, a mais equilibrada entre as quatro para as metas salvas de 90% de recall e 30% de redução, o teste cobriu 3.980 de 4.369 eventos; 389 ficaram fora. Foram cobertos 254 dos 271 gols, enquanto 17 ficaram fora. Das 965 finalizações no gol, 840 foram cobertas e 125 ficaram fora, revelando uma limitação que o recall agregado não mostra. A precisão das propostas de C foi 50,57% no teste, com 5.920 trechos unidos.

## 4. Discussão e limitações

A configuração B oferece a maior redução temporal no conjunto total (35,09%), mas seu recall total é 89,67%, abaixo da meta salva de 90%. A configuração D apresenta o maior recall agregado (92,13%) e a maior precisão de propostas (53,19%), com redução de 29,56%. A configuração C atinge simultaneamente 90% de recall e 30% de redução em treino, teste e no agregado. As demais metas também devem ser verificadas com os valores exatos: os nomes das configurações são rótulos aproximados, não resultados arredondados para decisão.

As configurações A–D são variações da **mesma regra**, não uma comparação com a regra alternativa de queda relativa de jogadores; não há configuração dessa alternativa entre os registros utilizados. A comparação é descritiva: o histórico não comprova que a escolha foi feita sem consulta ao teste. Se os parâmetros foram ajustados observando esse conjunto, o teste também é exploratório e não deve ser apresentado como validação independente. A divisão determinística por partida evita compartilhar os dois tempos entre conjuntos, mas não garante representatividade de outras competições ou transmissões.

Uma anotação temporalmente coberta não garante que todo o lance ou um replay relevante esteja visível, e um trecho sem anotação selecionada não é necessariamente irrelevante. Detecções YOLO podem falhar, e a resolução pode alterar as contagens. A redução de duração é um indicador de material filtrado; economia financeira, desempenho de uma LLM e qualidade editorial não foram medidos nestes resultados. Recomenda-se congelar parâmetros e avaliar em partidas independentes, além de inspecionar eventos perdidos e propostas visualmente.

## Fonte e reprodutibilidade

Fonte dos números: `saved_rules/configurations.json`, quatro registros salvos em 26/10/2026, todos com a mesma identificação da amostra e delta 0 s. A fotografia contém 497 tempos e não deve ser confundida com o total de arquivos processados posteriormente. Implementação das regras e métricas: `src/tcc_soccer_highlights/highlight_study.py`; descrição da divisão: `reports/highlight_study/regras_e_metodologia.md`.
