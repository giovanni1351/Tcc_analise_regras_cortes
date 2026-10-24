"""Descrições e pseudocódigo das regras que podem ser comparadas no simulador."""

RULE_NAMES = {
    'zero': 'Atual: cenas curtas com zeros',
    'context': 'Nova: queda de jogadores após campo aberto',
}


def rule_pseudocode(config):
    if config.get('rule', 'zero') == 'context':
        condition = f'''    anteriores = média das detecções nos 15 s anteriores ao início
    atuais = média das detecções dentro da cena
    se anteriores ou atuais forem indefinidos: continuar
    se anteriores < {config.get('min_previous', 6):g}: continuar
    queda = 1 - atuais / anteriores
    se queda < {config.get('drop_fraction', .65):g}: continuar'''
    else:
        condition = f'''    fração_zeros = amostras sem jogadores / total de amostras da cena
    se fração_zeros < {config['zero']:g}: continuar'''
        if config['preceding']:
            condition += '\n    se a média nos 15 s anteriores for indefinida ou menor que 6: continuar'
    return f'''qualificadas = lista vazia
para cada cena do vídeo:
    se início >= duração analisada: continuar
    se duração da cena > {config['short']:g} s: continuar
    se quantidade de amostras YOLO < 3: continuar
{condition}
    adicionar início da cena a qualificadas

# Contar sobre a lista original, incluindo a própria cena.
aprovadas = [t em qualificadas onde
             quantidade de qualificadas em [t - 10 s, t + 10 s] >= {config['cluster']}]

trechos = lista vazia
para cada t em aprovadas, em ordem crescente:
    início = máximo(0, t - {config['before']:g} s)
    fim = mínimo(duração analisada, t + {config['after']:g} s)
    adicionar [início, fim] a trechos

retornar união dos trechos sobrepostos ou que se encostam
# Anotações de eventos não participam da geração dos trechos.'''
