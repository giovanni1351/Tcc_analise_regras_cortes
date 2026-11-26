# Gemini 4 Hydrogen, execução de 13 e 14 de novembro de 2026

Esta atualização acrescenta uma comparação exploratória ao artigo, sem substituir as tabelas históricas de F1. `results.json` é uma cópia integral do resultado final auditado, em frações. `table.tex` e `../../figures/gemini4-map.pdf` são derivados dessa cópia por `render.py`, com conversão para porcentagem e arredondamento a duas casas decimais. As diferenças são calculadas antes do arredondamento.

## Origem e auditoria

- Repositório dos experimentos: `p4cs-974/tcc-workspace`, checkout local `/home/pedro/tcc`, commit de publicação `790e83fb`.
- Campanha: `docs/research/gemini-4-hydrogen-20261113-v1/`.
- Resultado canônico: `analysis/results.json`.
- Protocolo e seleção: `PROTOCOL.md`, `gate.json`, `execution-amendment.json`, `freeze.json` e `input-inventory.json`.
- Contabilidade: `ledger.jsonl`, `billing-before.json`, `billing-final-stable.json`, `verification-post-review.json`.
- Auditoria preservada: `final-audit.md` e `review-disposition.json`, copiados sem alterações para esta pasta.
- Arquivo publicado: `docs/research/data/gemini-4-hydrogen-20261113-results-v1.tar.gz`, SHA-256 `9a20b2edc66fb15e6563a4d0eba3edd715c8bed75bcc486b189db2659083ca5b`.
- Thread de origem: `98ca5275-f2dd-4ed8-bac2-37d609cacb7d`, “Evaluate Gemini 4 Hydrogen Capabilities”. O resultado final e as correções constam do relatório da campanha.

`source-hashes.json` identifica os bytes dos arquivos consultados no checkout dos experimentos. As cópias locais permitem conferir tabela e figura sem depender dos caminhos históricos dos vídeos. A reprodução completa da inferência e da verificação de requisições depende de mídia externa autorizada, não incluída aqui.

## Condições e limites

Amostra de teste exploratória previamente consultada, com duas partidas completas, 393 segmentos de 30 segundos e passo de 28 segundos, em 224p e 720p. Os mesmos vídeos e instruções foram usados para reavaliar Gemini 3.8 Flash. Scorer oficial SoccerNet 0.1.62, 2 fps, 17 classes, anotações visíveis e não visíveis; tight de 1 a 5 segundos, loose de 5 a 60 em passos de 5 segundos. Classes sem anotações permanecem na média macro. Os escores são calculados sobre o conjunto das partidas, não pela média das APs individuais.

Hydrogen Flex com raciocínio baixo e limite de 4.096 tokens de saída; Gemini 3.8 Standard anterior com o mesmo raciocínio e limite. Hydrogen omite temperatura, enquanto a configuração anterior solicitava 1,0. A seleção passou de uma para duas partidas após correção da fórmula de custo, antes de novas requisições e do cálculo dos escores Hydrogen. O subconjunto da baseline já havia sido examinado.

A auditoria confirmou escores e custo de US$ 3,54041775, 786 combinações aceitas, 793 tentativas, sete falhas e nenhuma cobrança pendente nas verificações finais. A estabilidade dos contadores não garante ausência de ajustes futuros do provedor.

Omitimos intervalos de confiança e alegações de significância. As 10.000 reamostragens pareadas com duas partidas produzem apenas três composições distintas e intervalos descritivos, não ICs calibrados. Não estabelecemos efeito de resolução nem generalização. Não inserimos F1, latência média, custo da baseline ou ganho do sistema integrado, pois esta comparação não fornece essas medidas auditadas. A análise provisória interrompida não preservou o código exato executado; os resultados finais vêm do replay completo auditado, que a substitui. A auditoria independente original encontrou problemas de relato corrigidos pelo agente principal; não houve uma segunda auditoria independente dessas correções.

## Reprodução da tabela e figura

Com Python e Matplotlib instalados, a partir da raiz deste repositório:

```sh
python latex/results/gemini4/render.py
```

Nesta máquina, usamos `/home/pedro/tcc/benchmark/.venv/bin/python`. Para compilar, a partir de `latex/`, com LaTeX, latexmk, biblatex-ieee e paracol instalados:

```sh
latexmk -pdf -interaction=nonstopmode -halt-on-error -outdir=build main.tex
```

O PDF fica em `latex/build/main.pdf`. Os arquivos gerados de compilação não fazem parte do commit. Atualização realizada com GPT-6.1 Sol, pelo harness Codex no T3 Code.

A compilação limpa do artigo original falhou em uma chave BibTeX duplicada, `giancola2018soccernet`. Removemos a segunda ocorrência, idêntica à primeira, de `referencias.bib`, preservando a chave e os dados da referência. Os pacotes biblatex-ieee e paracol foram instalados no TinyTeX local.

Validação: latexmk concluiu com código zero e gerou 11 páginas. Conferimos as 12 células numéricas da tabela no texto extraído do PDF e inspecionamos visualmente as páginas da tabela e da figura. Os hashes dos 13 arquivos de origem conferem. Não há erros fatais, caixas excedentes nem referências ou citações individualmente indefinidas. O conjunto de avisos é igual ao da versão anterior com a duplicata bibliográfica corrigida: multicol em duas colunas, backend BibTeX, substituições de fonte, ajuste de float e avisos gerais de referências e nova execução de BibTeX. Estes dois últimos persistem apesar da resolução dos rótulos e citações no PDF.
