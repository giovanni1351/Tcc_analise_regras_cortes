"""Explicações das métricas e dos controles exibidos no simulador."""
import streamlit as st


def render_simulator_glossary():
    st.divider()
    st.subheader('Glossário da análise')
    st.markdown('''
**Como ler os números**

Nas tabelas com nomes em inglês, uma proporção como `0,90` significa **90%**.
Os cartões e as colunas identificadas com `%` já mostram a porcentagem.
Valores vazios, `NaN` ou **—** indicam uma métrica indefinida naquele caso, e não necessariamente zero.

**Eventos e trechos selecionados**

| Métrica / nome na tabela | Significado e interpretação |
| --- | --- |
| **Eventos selecionados / Total de eventos / Total (`events`)** | Quantidade de ocorrências dos tipos escolhidos no filtro, dentro do período analisado. Por exemplo, selecionar Gol inclui todos os gols anotados nesse período. |
| **Delta dos eventos (`event_delta`)** | Tolerância simétrica em segundos em torno da anotação: **[instante − delta, instante + delta]**, limitada ao período analisado. Delta de 2 s gera um intervalo de 4 s, exceto nas bordas do vídeo. Zero mantém a avaliação pelo instante original. É uma tolerância escolhida, não a duração real conhecida do evento nem uma confirmação de replay. Vale também para a busca automática e para as duas resoluções; não amplia os trechos gerados. |
| **Cobertos / Capturados / Eventos selecionados cobertos (`hits`)** | Eventos cujo intervalo de tolerância toca ou sobrepõe pelo menos um trecho selecionado pela regra. Não é necessário cobrir o intervalo inteiro. Com delta zero, o instante anotado deve estar dentro do trecho. Os limites são incluídos. Cada evento conta uma vez, mesmo que vários trechos o capturem. |
| **Recall sem tolerância / Coberto sem tolerância (`captured_exact`)** | Avaliação dos mesmos trechos usando apenas o instante original (delta zero). Permite identificar os acertos adicionais decorrentes da tolerância. Aumentar o delta pode elevar o recall sem melhorar os trechos selecionados. |
| **Fora dos trechos / Perdidos (`missed`)** | **Total de eventos − eventos cobertos.** São os eventos selecionados que a regra deixou de capturar. Quanto menor, melhor a captura. |
| **Cobertura dos eventos / Cobertura (%) / Recall (`recall`)** | **Eventos cobertos ÷ total de eventos selecionados.** Se cobriu 90 de 100 eventos, o recall é 90%. Se cobriu todos, é 100%. Sem eventos selecionados no conjunto, é indefinido. |
| **Recall no vídeo / Eventos filtrados capturados** | A mesma avaliação, considerando somente o vídeo escolhido em “Inspecionar propostas no vídeo”. A contagem aparece como capturados / total desse vídeo. |
| **Cobertura temporal (`coverage`)** | **Duração total dos trechos selecionados ÷ duração analisada.** Mede quanto do vídeo foi mantido. É diferente da cobertura de eventos: manter 30% do vídeo não significa capturar 30% dos eventos. |
| **Redução temporal (`reducao_temporal` / `reduction`)** | **1 − cobertura temporal.** Se foram mantidos 30 minutos de 100 analisados, a redução é 70%. Valores maiores significam menos tempo de vídeo selecionado, mas podem acompanhar perda de eventos. Não é uma medição direta de economia financeira ou de processamento. |
| **Precisão das propostas (`proposal_precision`)** | **Trechos que intersectam o intervalo de pelo menos um evento selecionado ÷ total de trechos selecionados**, usando o delta atual. Se 12 de 20 trechos atendem a esse critério, a precisão é 60%. Um trecho longo com apenas um evento já conta como correto; essa métrica não mede quanto do trecho é relevante nem confirma replay. Sem propostas, ou sem tipos de evento selecionados, é indefinida. |
| **Propostas / Trechos selecionados (`proposals`)** | Número de intervalos candidatos gerados pela regra. Intervalos sobrepostos ou que se encostam são unidos, por isso várias cenas podem gerar uma única proposta. |
| **Tempo selecionado (`selected_sec`)** | Soma das durações dos trechos após a união dos intervalos. Não conta o mesmo segundo duas vezes dentro do mesmo vídeo. O cartão usa minutos; `selected_sec` usa segundos. |
| **Duração analisada (`total_sec`)** | Tempo de vídeo usado como denominador da cobertura temporal. Considera o período disponível com análise YOLO; pode ser menor que a duração completa do vídeo. |
| **Início, fim, duração e instante (s)** | Tempos em segundos desde o início do arquivo do respectivo tempo da partida. A duração de um trecho é fim − início; o instante de um evento é sua posição anotada no vídeo. |
| **Início / fim do evento (`event_start_sec` / `event_end_sec`)** | Limites calculados com o delta atual. Na timeline, as barras horizontais dos eventos representam esses intervalos. Na tabela, “Resultado” usa o delta e “Coberto sem tolerância” usa o instante original. |
| **Trecho / Cena** | Identificadores para localizar um intervalo selecionado ou uma cena. São números de identificação, não pontuações de qualidade. |

**Conjuntos de partidas e comparação de resoluções**

| Termo / métrica | Significado e interpretação |
| --- | --- |
| **Partidas únicas** | Quantidade de jogos diferentes disponíveis no estudo. Primeiro e segundo tempos da mesma partida não são dois jogos. |
| **Tempos únicos** | Quantidade de pares partida/tempo analisados. Na avaliação geral, utiliza-se a maior resolução disponível para cada par, sem duplicar o mesmo tempo por resolução. |
| **Horas com YOLO** | Soma da duração analisada dos tempos únicos, convertida em horas. Mede duração de vídeo coberta pela análise, não quanto o computador demorou para processá-la. |
| **Conjunto (`split`): treino** | Grupo de partidas usado para escolher os parâmetros padrão do estudo e para a busca automática. Ao alterar os controles manualmente, a linha mostra o resultado desses valores nesse grupo; não há um novo treinamento do YOLO. |
| **Conjunto (`split`): teste** | Grupo separado da busca automática, usado para avaliar como a regra escolhida funciona em outras partidas. Uma meta atingida no treino não garante o mesmo valor no teste. |
| **Todas as partidas** | Reúne treino e teste. Recall usa a soma dos eventos, cobertura temporal usa a soma das durações e precisão usa a soma das propostas. Não é a média simples das porcentagens das duas linhas. |
| **Resolução / 720p / 224p / 240p (`height`)** | Altura da imagem em pixels. Os arquivos atuais de baixa resolução são identificados como 224p. A comparação mantém os mesmos parâmetros da regra nas duas versões. |
| **Partidas pareadas** | Jogos cujo primeiro tempo possui análises utilizáveis nas duas resoluções escolhidas. Cada partida entra uma vez por resolução; segundos tempos ficam fora dessa comparação. |
| **Partidas sem par utilizável** | Jogos com alguma das resoluções de interesse, mas sem dados suficientes nas duas versões para entrar na comparação. Não entram nos totais pareados. |
| **Duração comum (s) / horas por resolução (`common_sec`)** | Período analisado disponível nas duas versões do primeiro tempo. Ambas são avaliadas sobre esse mesmo período e com as mesmas anotações de referência. Pode representar somente parte do primeiro tempo. |
| **Diferença 720p − resolução menor (p.p.)** | Diferença em **pontos percentuais**. Se o recall é 90% em 720p e 85% em 224p, a diferença é +5 p.p. Positivo significa valor maior em 720p; negativo significa valor maior na resolução menor. |

**Sinais das cenas e parâmetros da regra**

Os controles abaixo definem a regra; os valores mostrados nas tabelas de cenas descrevem o sinal observado.

| Termo / controle | Significado e interpretação |
| --- | --- |
| **Corte de câmera / cena** | Um corte detectado delimita cenas consecutivas do vídeo. Uma cena não é necessariamente um evento esportivo nem um replay. |
| **Regra para analisar** | Alterna entre a regra original de cenas curtas com zeros e a nova regra de queda relativa de jogadores após campo aberto. Todas as métricas, a timeline, os eventos perdidos e a comparação de resoluções usam a regra selecionada. A tabela entre regras aplica as duas às mesmas partidas e janelas. |
| **Cena máxima (s)** | Maior duração permitida para uma cena acionar a regra, ajustável de 1 a 120 s. Cenas mais longas são descartadas por esse critério. A busca automática pesquisa até 20 s por padrão e amplia a grade até o valor atual quando ele é maior. |
| **Amostras YOLO (`size`)** | Quantidade de frames analisados pelo YOLO dentro da cena. A regra exige pelo menos três amostras; isso não significa que todos os frames do vídeo foram analisados. |
| **Fração de zeros / amostras sem jogadores (`zero_fraction`)** | Amostras da cena com zero jogadores detectados ÷ total de amostras da cena. O controle estabelece o mínimo exigido. 100% significa zero detecções em todas as amostras; não comprova ausência real de jogadores nem confirma replay. Sem amostras, o valor é indefinido e a cena não aciona a regra. |
| **Média de jogadores na cena (`mean`)** | Média da quantidade de jogadores detectados por amostra na cena. É uma contagem de detecções, não uma porcentagem nem garantia da quantidade real de jogadores visíveis. |
| **Média de jogadores antes (`previous_players`)** | Média de jogadores detectados nas amostras dos 15 segundos anteriores ao início da cena. A opção “Exigir ≥6 jogadores antes” usa esse valor como condição adicional. |
| **Média mínima anterior (`min_previous`)** | Na nova regra, exige que a média nos 15 s anteriores alcance esse mínimo (6 por padrão). É um indício operacional de campo aberto, não uma identificação visual garantida. Substitui a opção fixa “Exigir ≥6 jogadores antes” da regra original. |
| **Queda relativa de jogadores / queda mínima (`drop_fraction` / `player_drop`)** | **1 − média de jogadores na cena ÷ média nos 15 s anteriores.** De 10 para 3 detecções representa queda de 70%. A nova regra exige pelo menos 65% por padrão, além do contexto anterior mínimo; não usa a fração de zeros. No gráfico, aumentos de jogadores aparecem como 0%; a tabela preserva o valor calculado. Sem média anterior positiva, a queda é indefinida. |
| **Cenas qualificadas em ±10 s (`cluster`)** | Quantidade mínima de cenas que passam pelos critérios básicos e começam até 10 segundos antes ou depois do início da cena avaliada, incluindo ela própria. |
| **Cenas que acionam a regra** | Número de cenas do vídeo inspecionado que satisfazem todas as condições atuais. Não é necessariamente igual ao número de trechos, pois os intervalos gerados podem ser unidos. |
| **Tempo antes / depois (`before` / `after`)** | Janela capturada em torno do **início da cena** aprovada. Exemplo: início em 60 s, antes = 20 e depois = 25 gera [40, 85] s. Os limites respeitam a duração analisada do vídeo. |

**Busca automática e comparação com o resultado anterior**

| Termo / métrica | Significado e interpretação |
| --- | --- |
| **Recall mínimo no treino** | Exigência escolhida para a próxima busca. O algoritmo maximiza a redução temporal entre as combinações que alcançam pelo menos esse recall no treino. O mínimo é uma condição, não uma previsão do resultado no teste. |
| **Ajuste manual da nova regra** | A busca automática continua restrita à regra original. Na nova regra, os controles são ajustados manualmente; o pseudocódigo da página mostra os valores e as condições usados na avaliação atual. |
| **Limite de cada janela na busca (s)** | Maior valor permitido para cada janela antes/depois durante a busca. Os seis controles principais mostram a configuração atual; não são todos limites da busca. |
| **Regras / combinações avaliadas** | No progresso, cada regra reúne duração máxima, fração de zeros, agrupamento e exigência de jogadores anteriores. Cada combinação completa inclui também as janelas antes/depois. A contagem mostra o tamanho da busca, não sua qualidade. |
| **Recall máximo alcançável** | Maior recall encontrado dentro dos limites pesquisados. Quando ele fica abaixo da meta, a busca não aplica uma nova configuração. |
| **Variação abaixo dos indicadores (p.p.)** | Diferença entre a avaliação dos controles atuais e a configuração anterior à última busca. Passar de 80% para 90% é +10 p.p., e não um aumento relativo de 10%. |
| **Recall mínimo usado na última busca / histórico da busca** | Registro da última execução. O histórico mantém os resultados daquela execução; os indicadores da avaliação atual acompanham as alterações manuais. O gráfico mostra a evolução da melhor solução viável conforme as regras são avaliadas. |

**Configurações salvas e resumo**

| Termo / métrica | Significado e interpretação |
| --- | --- |
| **Meta de recall / meta de redução temporal** | Valores mínimos desejados para a configuração salva. São critérios de avaliação do resultado; salvar uma meta não executa uma busca nem altera os trechos. A meta de recall da busca automática continua sendo definida nas opções da busca. |
| **Atingiu as duas metas** | O recall e a redução temporal alcançam os respectivos mínimos no conjunto exibido. Sem eventos, o recall fica indefinido e a linha não atende às duas metas. |
| **Resultado salvo** | Fotografia dos parâmetros, eventos, delta e métricas no momento do salvamento. Não muda quando novos vídeos são adicionados ou os controles são alterados. |
| **Comparação comum / reavaliação** | Recalcula cada regra salva com seus parâmetros, usando as mesmas partidas atuais, eventos e delta escolhidos na comparação. Preserva os resultados salvos e as metas de cada configuração. |

**Exemplo para distinguir as três métricas principais:** de 100 eventos selecionados,
90 tiveram seus intervalos intersectados pelos trechos (**recall de 90%**). Os trechos mantiveram 30 de 100 minutos
de vídeo (**cobertura temporal de 30% e redução de 70%**). Se 12 dos 20 trechos intersectam
o intervalo de ao menos um desses eventos, a **precisão das propostas é 60%**.
''')
