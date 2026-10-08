"""PDF multipágina e guia Markdown, sem dependências além de Matplotlib."""
from __future__ import annotations

import textwrap

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np

from tcc_soccer_highlights.highlight_study import TARGETS


def render_report(r, out):
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':10})
    q, ev, cfg = r['quality'], r['events'], r['config']
    game_codes={g:f'J{i+1:02}' for i,g in enumerate(sorted(q.game.unique()))}
    selected = r['ablations'][r['ablations'].rule.eq('Regra escolhida')]
    def pct(v): return f'{v:.1%}' if np.isfinite(v) else 'indisponível'
    md=[]
    figure_number=0
    with PdfPages(out/'relatorio_eventos_cortes_yolo.pdf') as pdf:
        def prose(title, paragraphs):
            md.append('## '+title+'\n\n'+'\n\n'.join(paragraphs))
            fig=plt.figure(figsize=(8.27,11.69)); fig.patch.set_facecolor('#fafbfe')
            fig.text(.08,.94,title,fontsize=19,weight='bold',color='#173858',va='top',wrap=True)
            y=.86
            for p in paragraphs:
                lines=textwrap.wrap(p,width=91,break_long_words=False,break_on_hyphens=False)
                needed=len(lines)*.023+.035
                if y-needed < .075:
                    footer(fig); pdf.savefig(fig); plt.close(fig)
                    fig=plt.figure(figsize=(8.27,11.69)); fig.patch.set_facecolor('#fafbfe')
                    fig.text(.08,.94,title+' (continuação)',fontsize=17,weight='bold',color='#173858',va='top')
                    y=.86
                fig.text(.08,y,'\n'.join(lines),fontsize=11,va='top',linespacing=1.6)
                y-=needed
            footer(fig); pdf.savefig(fig); plt.close(fig)
        def footer(fig):
            fig.text(.08,.035,f'TCC Soccer Highlights | fotografia {r["created"]} | estudo exploratório',fontsize=8,color='#64748b')
        def chart(title, draw, caption):
            nonlocal figure_number
            figure_number+=1
            image_name=f'figura_{figure_number:02}.png'
            md.append(f'## {title}\n\n![{title}]({image_name})\n\n{caption}')
            fig,ax=plt.subplots(figsize=(11.69,8.27)); draw(ax)
            ax.set_title(title,fontsize=16,pad=20); fig.subplots_adjust(left=.12,right=.95,top=.87,bottom=.25)
            fig.text(.08,.16,'\n'.join(textwrap.wrap(caption,120)),fontsize=10,va='top')
            footer(fig); pdf.savefig(fig); fig.savefig(out/image_name,dpi=150); plt.close(fig)
        def table(title, df, caption):
            df=df.copy()
            if 'game' in df and len(df.columns)>3:
                df['game']=df.game.map(game_codes).fillna(df.game)
            def draw(ax):
                ax.axis('off')
                widths=[.1,.8,.1] if list(df.columns)==['código','game','split'] else None
                headers=['\n'.join(textwrap.wrap(str(c),16,break_long_words=True)) for c in df.columns]
                t=ax.table(cellText=df.round(3).astype(str).values,colLabels=headers,loc='center',cellLoc='center',colWidths=widths)
                t.auto_set_font_size(False); t.set_fontsize(8); t.scale(1,1.8)
                for (row,col),cell in t.get_celld().items():
                    if row==0: cell.set_facecolor('#173858'); cell.set_text_props(color='white',weight='bold')
            chart(title,draw,caption)

        prose('Eventos, cortes e detecções de jogadores',[
            'Estudo exploratório para pré-seleção de melhores momentos e redução do contexto enviado a uma LLM.',
            f'Fotografia: {r["created"]}. Foram lidos {r["source_files"]} arquivos completos. A análise principal usa {len(q)} tempos únicos de {q.game.nunique()} partidas, com {q.events.sum()} eventos e {q.covered_sec.sum()/3600:.2f} horas cobertas pelo YOLO.',
            'Hipótese: a edição televisiva após certos eventos apresenta mais mudanças de cena, planos curtos e poucas detecções de jogadores. A hipótese é testada; nenhuma correlação é presumida.',
            'As anotações servem para medir os resultados. O filtro de produção utiliza somente cenas do TransNetV2 e contagens do YOLO. Não há chamada a LLM nem gasto de API neste estudo.'
        ])
        prose('Método e unidade de análise',[
            'Arquivos da mesma competição, temporada, partida e tempo são duplicatas de conteúdo. Foi mantida a maior resolução disponível em cada grupo. Os tempos de uma mesma partida permanecem no mesmo conjunto de avaliação.',
            'A contagem de cortes considera os inícios de cena, excluindo t=0. Uma cena curta tem duração de até 8 s na análise descritiva. Cena curta com baixa detecção exige pelo menos três amostras YOLO e zero jogadores em pelo menos 80% delas.',
            'Para cada evento com 30 s disponíveis de ambos os lados, comparamos [-30,0) e [0,30) s. Os controles são janelas de 30 s na mesma transmissão, com centro afastado mais de 60 s de qualquer anotação. Controles não garantem ausência de acontecimentos não anotados.',
            'Cada partida recebe o mesmo peso nos contrastes: primeiro agregamos eventos por vídeo e tempos por partida. Os intervalos de 95% vêm de 2.000 reamostragens de partidas, semente 42. Eles expressam a incerteza deste recorte e não corrigem todas as comparações exploratórias.',
            'Janelas de eventos podem sobrepor-se; frames e eventos não são observações independentes. A série temporal é descritiva. Associação com a edição não implica causalidade nem identifica por si só o tipo de jogada.'
        ])
        overview=q.groupby(['height','split']).agg(tempos=('video_id','size'),eventos=('events','sum'),horas=('covered_sec',lambda x:x.sum()/3600)).reset_index()
        table('Amostra e divisão por partida',overview,'Divisão determinística: uma a cada três partidas, em ordem de nome, vai para teste; as demais vão para treino. Com menos de seis partidas não há teste separado. O processamento em andamento pode alterar este recorte em uma próxima execução.')
        games=q[['game','split']].drop_duplicates().sort_values('game').copy(); games.insert(0,'código',games.game.map(game_codes))
        table('Identificação das partidas',games,'Os códigos J01, J02 etc. identificam as partidas nas tabelas pareadas. A lista completa de tempos, resolução e cobertura está em quality.csv.')
        grouped=ev.groupby('label').agg(eventos=('time_sec','size'),cortes_antes=('pre_cuts','mean'),cortes_depois=('post_cuts','mean'),zero_antes=('pre_zero_fraction','mean'),zero_depois=('post_zero_fraction','mean'),curtas_zero_depois=('post_short_zero','mean')).reset_index()
        table('Comportamento por tipo de evento',grouped,'Médias descritivas por evento em janelas de 30 s. zero é a fração de amostras com player_count=0. curtas_zero é a contagem de cenas com até 8 s e pelo menos 80% de amostras sem jogadores detectados. Eventos próximos podem compartilhar cenas.')
        effects=r['effects']
        table('Contrastes e incerteza por partida',effects,'difference = média depois - média da referência. pre: 30 s anteriores; control: períodos afastados das anotações. cuts e short_zero são contagens por 30 s; zero_fraction é proporção; players é contagem média. Intervalos que incluem zero não sustentam diferença estável neste recorte.')
        findings=[]
        names={'cuts':'cortes por 30 s','short_zero':'cenas curtas com baixa detecção por 30 s','zero_fraction':'fração de zero detecções','players':'média de jogadores detectados'}
        for x in effects.itertuples():
            if x.baseline=='control':
                status='aumento com intervalo acima de zero' if x.ci_low>0 else ('redução com intervalo abaixo de zero' if x.ci_high<0 else 'diferença com intervalo incluindo zero')
                findings.append(f'{names[x.metric]}: diferença {x.difference:.3f}, IC95% [{x.ci_low:.3f}, {x.ci_high:.3f}]; {status}, em {x.matches} partidas com controle.')
        prose('O que os dados sustentam',findings+[
            'A afirmação “sempre depois de um evento” deve ser substituída pelas taxas medidas por classe. A ausência do padrão não é evidência de ausência de um melhor momento. Saídas de bola, faltas e substituições também podem causar closes e cortes.',
            'Segundo a observação do grupo, o YOLO foi treinado para a câmera aberta padrão e deixa de detectar jogadores em closes e replays de outros ângulos. Assim, zero jogadores é uma pista de mudança de domínio visual. Não distingue automaticamente replay, torcida, close, placar ou baixa resolução; precisa de inspeção humana.'
        ])
        def lagchart(ax):
            for label in ['Goal','Shots on target','Ball out of play','Foul']:
                sub=r['lag'][r['lag'].label.eq(label)]
                if len(sub):
                    v=sub.groupby(['game','lag_sec']).players.mean().groupby('lag_sec').mean()
                    ax.plot(v.index+2.5,v.values,marker='o',label=f'{label} (n={int((ev.label==label).sum())})')
            ax.axvline(0,color='black',ls='--'); ax.set_xlabel('Segundos relativos à anotação (centro de janelas de 5 s)'); ax.set_ylabel('Média de jogadores detectados pelo YOLO'); ax.set_ylim(bottom=0); ax.legend()
        chart('Perfil temporal ao redor dos eventos',lagchart,'Quanto mais alta a linha, mais jogadores detectados em média pelo YOLO. Cada ponto resume uma janela de 5 s: média das amostras, depois dos eventos da mesma partida e depois entre partidas, com peso igual por partida. São detecções, não a quantidade real de jogadores mostrados. Eventos próximos podem compartilhar cenas. Após +30 s, o número de eventos elegíveis pode diminuir nos finais dos vídeos.')
        def resolution(ax):
            res=r['resolutions']; pivot=res.pivot_table(index=['game','half'],columns='height',values='zero_fraction')
            if 224 in pivot and 720 in pivot:
                pair=pivot[[224,720]].dropna(); ax.scatter(pair[224],pair[720]); ax.plot([0,1],[0,1],'--',color='gray')
                ax.set_xlabel('224p: fração de zero detecções'); ax.set_ylabel('720p: fração de zero detecções'); ax.set_title(f'{len(pair)} tempos com ambas as resoluções')
            else:
                res.boxplot(column='zero_fraction',by='height',ax=ax); ax.set_xlabel('Altura do vídeo'); ax.set_ylabel('Fração de zero detecções')
        chart('Sensibilidade à resolução',resolution,'Cada ponto pareado representa o mesmo tempo de partida. Diferenças mostram que limiares de contagem não devem ser transferidos entre resoluções sem validação. A análise principal usa a maior resolução já processada, que não é necessariamente uniforme entre todos os tempos.')
        if 'resolution_pairs' in r and len(r['resolution_pairs']):
            pairs=r['resolution_pairs']; filters=r['resolution_filter']
            means=pairs.groupby('game').mean(numeric_only=True)
            rng=np.random.default_rng(42); delta=(means.zero_720-means.zero_224).to_numpy()
            boots=rng.choice(delta,(2000,len(delta)),replace=True).mean(axis=1)
            low,high=np.quantile(boots,[.025,.975])
            table('224p versus 720p: mesmo conteúdo e timestamp',pairs[['game','half','players_224','players_720','zero_224','zero_720','zero_224_given_open720','agreement_zero']].rename(columns={'zero_224_given_open720':'zero224|aberta720','agreement_zero':'acordo_zero'}),'Médias por tempo, apenas em timestamps comuns. Câmera aberta operacional: >=6 jogadores no 720p. Não há anotação de jogadores/câmeras; 720p não é ground truth. acordo_zero mede se as duas versões concordam sobre zero versus alguma detecção.')
            def paired_scatter(ax):
                ax.scatter(pairs.players_224,pairs.players_720)
                upper=max(pairs.players_224.max(),pairs.players_720.max())*1.1
                ax.plot([0,upper],[0,upper],'--',color='gray'); ax.set_xlabel('Jogadores médios em 224p'); ax.set_ylabel('Jogadores médios em 720p')
            chart('Ganho de contagem na resolução maior',paired_scatter,'Comparação pareada por tempo de partida. Mais detecções não garantem mais acurácia: faltam caixas anotadas para medir precision/recall do detector e separar falsos positivos.')
            summ=filters.groupby('height').agg(hits=('hits','sum'),events=('events','sum'),coverage=('coverage','mean'),proposal_precision=('proposal_precision','mean')).reset_index(); summ['recall']=summ.hits/summ.events
            table('A mesma regra em ambas as resoluções',summ,'Mesmos tempos, anotações e limiares; nenhuma recalibração por resolução. Recall agregado por evento; cobertura e precisão são médias por tempo, sem ponderação por duração. Esta comparação é diagnóstica e inclui treino e teste; não usar para escolher novos limiares no teste.')
            ratio=(pairs.processing_720/pairs.processing_224).median()
            storage=(pairs.size_720/pairs.size_224).median()
            prose('Vale a pena usar 720p?',[
                f'Comparação com {len(pairs)} tempos pareados de {pairs.game.nunique()} partidas. Média por partida: jogadores 224p={means.players_224.mean():.2f}, 720p={means.players_720.mean():.2f}; fração de zeros 224p={pct(means.zero_224.mean())}, 720p={pct(means.zero_720.mean())}. Diferença 720p-224p em zeros={delta.mean():.3f}, IC95% [{low:.3f}, {high:.3f}].',
                f'Quando 720p detecta pelo menos seis jogadores, 224p produz zero em média em {pct(means.zero_224_given_open720.mean())} dos timestamps. Esse é um indicador operacional de zeros possivelmente causados pela qualidade, não uma taxa de erro comprovada.',
                f'O processamento completo do pipeline em 720p levou mediana de {ratio:.2f} vezes o tempo de 224p; o arquivo ocupou {storage:.2f} vezes o tamanho. Os tempos incluem leitura, YOLO, TransNet e escrita de Excel: não isolam o custo de inferência nem controlam temperatura/GPU/processos concorrentes.',
                f'No TransNet, houve em média {pairs.cuts_224.mean():.1f} cortes por tempo em 224p e {pairs.cuts_720.mean():.1f} em 720p. Em média, {pairs.cuts224_matched_720.mean():.2%} dos cortes 224p têm ao menos um corte 720p a até 0,5 s. É concordância entre versões, não precisão contra cortes anotados; não exige correspondência um a um.',
                'No código local, o TransNet recebe frames RGB redimensionados para 48×27. O YOLO usa LetterBox e tamanho de inferência definido por imgsz (padrão instalado 640); model.predict não fixa imgsz no pipeline. O peso pode sobrescrever o padrão. Portanto, o YOLO também redimensiona: 720p preserva mais informação antes desse passo, mas não significa processar todos os pixels originais.',
                f'Com a mesma regra, 224p recuperou {int(summ.loc[summ.height.eq(224),"hits"].iloc[0])}/{int(summ.loc[summ.height.eq(224),"events"].iloc[0])} eventos-alvo e 720p recuperou {int(summ.loc[summ.height.eq(720),"hits"].iloc[0])}/{int(summ.loc[summ.height.eq(720),"events"].iloc[0])}. Neste recorte, o ganho de contagem em 720p não trouxe ganho de recall para o filtro. Manter 224p é uma escolha inicial mais econômica para este objetivo; fixar resolução, imgsz e confiança na calibração.',
                'Isso não valida 224p para detectar a bola, identidade dos jogadores ou detalhes da jogada: essas tarefas não foram avaliadas. Se a LLM precisar de detalhes, recuperar frames em maior resolução somente dos trechos selecionados. A comparação inclui apenas os tempos em que ambas as versões já terminaram.',
                'Uma arquitetura candidata é TransNet no vídeo reduzido e YOLO em frames 720p somente nas cenas relevantes. Validar esse novo desenho em conjunto separado, pois a medição atual executou o pipeline inteiro. Replays em outros ângulos continuarão fora do domínio mesmo em 720p.'
            ])
        prose('Definição de melhores momentos e métricas',[
            'Eventos-alvo operacionais neste estudo: '+', '.join(TARGETS)+'. É uma definição inicial para gols, finalizações, pênaltis e expulsões. Faltas, amarelos e escanteios podem ser adicionados pelo grupo; não são automaticamente melhores momentos.',
            'Recall de eventos = anotações-alvo cujo instante está dentro de algum intervalo selecionado / total de anotações-alvo. Estar dentro do intervalo não garante que toda a jogada esteja visível ou que a LLM consiga classificá-la.',
            'Cobertura = duração da união dos intervalos / duração coberta pelo YOLO. Redução de contexto temporal = 1 - cobertura. A precisão de propostas mede a fração dos intervalos unidos contendo ao menos um evento-alvo. Não é precisão por frame nem mAP de action spotting.',
            'A economia monetária não foi medida: depende do modelo, frames enviados, resolução, áudio e tokens. Com amostragem uniforme, a duração é um proxy inicial de frames; deduplicação e orçamento de envio devem ser avaliados separadamente.'
        ])
        table('Filtro: treino e teste sem vazamento de partidas',r['ablations'],'Limiar escolhido somente no treino entre 18 combinações. Se recall >=90% for atingido, escolhe-se a menor cobertura; caso contrário, maximiza-se recall - 0,5 × cobertura. Teste é usado apenas para relatar desempenho. Ablações são comparações exploratórias, não novas regras selecionadas pelo teste.')
        results=[f'{x.split}: recall {pct(x.recall)} ({x.hits}/{x.events}), cobertura {pct(x.coverage)}, redução temporal {pct(1-x.coverage)}, precisão de propostas {pct(x.proposal_precision)} ({x.proposals} propostas).' for x in selected.itertuples()]
        prose('Regra candidata para a solução final',[
            f'1. Extrair cenas do TransNetV2 e calcular fração de player_count=0 usando somente amostras YOLO válidas. Disparar em cenas com duração <= {cfg["short"]} s, pelo menos três amostras e fração de zeros >= {cfg["zero"]:.0%}.',
            f'2. Exigir pelo menos {cfg["cluster"]} cena(s) qualificadas em ±10 s do início da cena candidata. O próprio início conta. É uma regra offline com atraso de até 10 s para confirmar agrupamento.',
            '3. Para cada início qualificado a, propor [a-20, a+25] s, limitar ao vídeo e unir intervalos sobrepostos. A janela anterior preserva a ação que pode ter causado o close posterior. A regra não conhece a anotação do evento.',
            '4. Exportar início, fim e evidências. Dividir propostas longas em blocos de até 90 s com 5 s de sobreposição para preservar contexto entre blocos; isso aumenta levemente a duração enviada e não foi incluído na cobertura medida.',
            '5. Enviar à LLM uma seleção de frames da ação anterior, da mudança visual e do contexto posterior. Solicitar tipo de evento, relevância e justificativa visual. Fixar orçamento de frames por trecho e medir perdas antes de descartar material.',
        ]+results)
        prose('Como escolher o compromisso para produção',[
            'A regra candidata representa o melhor compromisso da busca que exige o sinal YOLO. Se nenhuma configuração atinge 90% de recall no treino, a seleção usa uma função exploratória que troca recuperação por cobertura; isso não estabelece um nível aceitável de perdas para o TCC.',
            'Compare a ablação “Só cenas curtas”: se recuperar mais eventos com aumento pequeno de cobertura, a contagem YOLO deve funcionar como prioridade de envio, em vez de exclusão obrigatória. Assim o grupo pode preservar propostas sem queda de detecção para uma segunda fila.',
            'Agrupamento mais exigente reduz a duração selecionada, mas pode perder jogadas isoladas. Não recomendar essa opção como filtro exclusivo sem aceitar explicitamente o recall observado. Gols e expulsões raros exigem auditoria individual.',
            'A proposta prática é uma fila prioritária de cenas curtas com mudança de domínio, seguida de uma fila de segurança de cenas curtas sem exigir zeros. Fixar o orçamento com dados de treino e medir separadamente recall, custo da LLM e qualidade dos clipes.'
        ])
        def flow(ax):
            ax.axis('off')
            boxes=['Vídeo → cenas TransNet + amostras YOLO','Cena curta + zeros frequentes + mínimo de amostras','Confirmar agrupamento temporal (regra escolhida)','Recuperar ação anterior: -20 s / +25 s','Unir propostas → segmentar e limitar frames','LLM avalia relevância → montar melhores momentos']
            for i,label in enumerate(boxes):
                y=.92-i*.155; ax.text(.5,y,label,ha='center',va='center',bbox=dict(boxstyle='round,pad=.75',fc='#e5effa',ec='#173858'),fontsize=12)
                if i<len(boxes)-1: ax.annotate('',xy=(.5,y-.105),xytext=(.5,y-.045),arrowprops=dict(arrowstyle='->',color='#173858',lw=2))
        chart('Fluxo operacional sem anotações de eventos',flow,'As anotações SoccerNet aparecem apenas na avaliação offline. Antes da produção, manter uma amostra aleatória dos trechos descartados para auditar os falsos negativos e mudanças de domínio.')
        precision=r['evaluation'].groupby(['split','label'])[['hits','events']].sum().reset_index(); precision['recall']=precision.hits/precision.events
        for split in ['treino','teste']:
            part=precision[precision.split.eq(split)].drop(columns='split')
            if len(part): table(f'Recuperação por classe — {split}',part,'Inclui classes que não são alvos, para mostrar que sinais de edição também selecionam acontecimentos rotineiros. Classes raras podem ter estimativas extremas; sempre ler o numerador e denominador.')
        def tradeoff(ax):
            g=r['grid']; points=ax.scatter(g.coverage,g.recall,c=g.short,cmap='viridis',s=65)
            chosen=g[(g.short==cfg['short'])&(g.zero==cfg['zero'])&(g.cluster==cfg['cluster'])]
            ax.scatter(chosen.coverage,chosen.recall,s=220,facecolors='none',edgecolors='red',linewidths=2,label='Escolhida no treino')
            ax.set_xlabel('Fração temporal selecionada'); ax.set_ylabel('Recall de eventos-alvo'); ax.legend(); ax.figure.colorbar(points,ax=ax,label='Duração máxima da cena (s)')
        chart('Compromisso entre custo e recuperação',tradeoff,'18 configurações avaliadas somente no treino: duração máxima 4/8/12 s, fração de zeros 50/80/100%, agrupamento mínimo 1/2. O desempenho da regra final em teste está na tabela de avaliação, não nesta busca.')
        prose('Limitações e próximos experimentos',[
            'Amostra parcial e de conveniência: foram analisados os arquivos completos disponíveis, na ordem do processamento. Resultados não representam todo o dataset ou todas as ligas. Não interrompemos nem reprocessamos os vídeos em execução.',
            'As anotações incluem eventos visíveis e não exibidos. Avaliar ambos é conservador para seleção visual, mas convém reportar também uma avaliação restrita a visibility=visible. A precisão temporal das anotações e transições exige revisão de exemplos.',
            'Os intervalos de confiança são exploratórios. Eventos-alvo raros e poucos jogos no teste limitam conclusões. O limiar escolhido é uma configuração candidata, não uma regra universal validada.',
            'Inspecionar vídeos de verdadeiros positivos, propostas sem alvos e eventos perdidos. Auditar gols sem close, replays repetidos, começo/fim de tempo e vídeos 224p. Medir se a janela inclui a construção e o desfecho da jogada.',
            'Quando mais partidas terminarem, repetir o estudo com divisão fixa por partida, validar por competição e resolução e depois reservar um conjunto final intocado. Medir classificação da LLM, custo real, recall e qualidade dos clipes completos.',
            'Não descartar permanentemente uma cena longa ou com muitos jogadores: esse é justamente o plano em que a ação acontece. Os zeros e cortes servem para disparar recuperação do contexto anterior.'
        ])
        prose('Reprodução e arquivos para o grupo',[
            'Executar na raiz: .venv/Scripts/python.exe -m tcc_soccer_highlights.highlight_study. Os Excels existentes são lidos; não há inferência adicional de YOLO/TransNet nem chamadas externas.',
            'snapshot.json registra data, arquivos e configuração. quality.csv contém a amostra; events.csv, lag.csv, paired.csv e effects.csv contêm resultados descritivos; grid.csv registra a seleção no treino; evaluation.csv e ablations.csv contêm a avaliação.',
            'clips.csv contém candidatos para integração: video_id, game, split, start_sec, end_sec, duration_sec, reason. Esses trechos ainda precisam da avaliação semântica da LLM. Nenhum vídeo foi cortado automaticamente.',
            'No Streamlit, as páginas “Eventos, cortes e YOLO”, “Simulador de regras” e “Relatório do estudo” permitem explorar os dados e baixar artefatos. O relatório é uma fotografia; atualizar o painel não atualiza automaticamente o PDF.'
        ])
    (out/'regras_e_metodologia.md').write_text('# Estudo de seleção de melhores momentos\n\n'+'\n\n'.join(md),encoding='utf-8')
    for old in out.glob('figura_*.png'):
        suffix=old.stem.removeprefix('figura_')
        if suffix.isdigit() and int(suffix)>figure_number:
            old.unlink()
