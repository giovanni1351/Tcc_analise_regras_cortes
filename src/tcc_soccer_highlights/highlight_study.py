"""Estudo reproduzível offline; anotações são usadas somente na avaliação."""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

TARGETS = ['Goal', 'Shots on target', 'Shots off target', 'Penalty', 'Red card', 'Yellow->red card']


def canonical(items):
    groups = {}
    for key, data in items.items():
        if 'error' in data or data.get('samples', pd.DataFrame()).empty:
            continue
        m = data['meta']
        group = (m.get('competition'), m.get('season'), m.get('game'), m.get('half'))
        if group not in groups or float(m.get('height', 0)) > float(groups[group][1]['meta'].get('height', 0)):
            groups[group] = (key, data)
    return dict(groups.values())


def scene_features(data):
    s = data['scenes'].copy()
    samples = data['samples'].sort_values('time_sec')
    counts = samples.groupby('scene_id').player_count.agg(['size', 'mean', 'max'])
    zero = samples.assign(zero=samples.player_count.eq(0)).groupby('scene_id').zero.mean()
    s = s.merge(counts, left_on='scene_id', right_index=True, how='left')
    s['zero_fraction'] = s.scene_id.map(zero)
    t, p = samples.time_sec.to_numpy(), samples.player_count.to_numpy()
    lo = np.searchsorted(t, s.start_sec.to_numpy()-15)
    hi = np.searchsorted(t, s.start_sec.to_numpy())
    sums = np.r_[0., np.nancumsum(p)]
    missing = np.r_[0, np.cumsum(np.isnan(p))]
    means = np.full(len(s), np.nan)
    valid = (hi > lo) & (missing[hi] == missing[lo])
    means[valid] = (sums[hi[valid]]-sums[lo[valid]])/(hi[valid]-lo[valid])
    s['previous_players'] = means
    return s


def qualifying_scenes(features, duration, short=8, zero=.8, cluster=1, preceding=False, use_zero=True):
    """Máscara das cenas que efetivamente geram propostas, na ordem original."""
    mask = features.duration_sec.le(short) & features['size'].ge(3)
    if use_zero:
        mask &= features.zero_fraction.ge(zero)
    if preceding:
        mask &= features.previous_players.ge(6)
    mask &= features.start_sec.lt(duration)
    anchors = np.sort(features.loc[mask, 'start_sec'].to_numpy(float))
    if cluster > 1:
        counts = np.searchsorted(anchors, anchors+10, side='right')-np.searchsorted(anchors, anchors-10)
        anchors = anchors[counts >= cluster]
    return mask & features.start_sec.isin(anchors)


def intervals(features, duration, short=8, zero=.8, cluster=1, preceding=False, use_zero=True,
              before=20, after=25):
    if not np.isfinite(before) or not np.isfinite(after) or before < 0 or after < 0 or before + after <= 0:
        raise ValueError('Os tempos antes e depois devem ser não negativos e somar mais de zero.')
    mask = qualifying_scenes(features, duration, short, zero, cluster, preceding, use_zero)
    anchors = np.sort(features.loc[mask, 'start_sec'].to_numpy(float))
    merged = []
    for a in anchors:
        lo, hi = max(0., a-before), min(duration, a+after)
        if merged and lo <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], hi)
        else:
            merged.append([lo, hi])
    return merged


def evaluate(records, config):
    rows, clips = [], []
    for key, r in records.items():
        spans = intervals(r['features'], r['duration'], **config)
        selected = sum(b-a for a, b in spans)
        bounds = np.asarray(spans, dtype=float).reshape(-1, 2)
        for i, (a, b) in enumerate(spans):
            clips.append(dict(video_id=key, game=r['game'], split=r['split'], start_sec=a, end_sec=b,
                              duration_sec=b-a, reason='Sequência de cenas curtas / evidência YOLO'))
        for label, events in r['events'].groupby('label'):
            times = events.time_sec.to_numpy(float)
            if len(bounds):
                idx = np.searchsorted(bounds[:, 0], times, side='right')-1
                hit = int(((idx >= 0) & (times <= bounds[np.maximum(idx, 0), 1])).sum())
            else:
                hit = 0
            rows.append(dict(video_id=key, game=r['game'], split=r['split'], label=label,
                             events=len(events), hits=hit, selected_sec=selected, total_sec=r['duration']))
    return pd.DataFrame(rows), pd.DataFrame(clips, columns=['video_id','game','split','start_sec','end_sec','duration_sec','reason'])


def scores(evaluation, clips, records, split, labels=None):
    labels = TARGETS if labels is None else labels
    e = evaluation[evaluation.split.eq(split) & evaluation.label.isin(labels)]
    total = sum(r['duration'] for r in records.values() if r['split'] == split)
    c = clips[clips.split.eq(split)]
    hits, n = int(e.hits.sum()), int(e.events.sum())
    # Precisão de propostas: conter ao menos um evento-alvo, sem chamar isso precisão por frame.
    relevant = 0
    for key, proposals in c.groupby('video_id'):
        ev = records[key]['events']
        times = np.sort(ev.loc[ev.label.isin(labels), 'time_sec'].to_numpy(float))
        counts = np.searchsorted(times, proposals.end_sec.to_numpy(), side='right')-np.searchsorted(times, proposals.start_sec.to_numpy())
        relevant += int((counts > 0).sum())
    return dict(split=split, hits=hits, events=n, recall=hits/n if n else np.nan,
                coverage=c.duration_sec.sum()/total if total else np.nan,
                proposal_precision=relevant/len(c) if len(c) and len(labels) else np.nan, proposals=len(c))


def study(items):
    chosen = canonical(items)
    games = sorted({str(d['meta']['game']) for d in chosen.values()})
    test_games = set(games[::3]) if len(games) >= 6 else set()
    records, event_rows, lag_rows, paired, quality = {}, [], [], [], []
    rng = np.random.default_rng(42)
    for key, data in chosen.items():
        m = data['meta']; duration = float(m['duration_sec'])
        samples = data['samples'].sort_values('time_sec'); events = data['events'].copy()
        features = scene_features(data)
        t = samples.time_sec.to_numpy(float); players = samples.player_count.to_numpy(float)
        # Somente tempos cobertos por YOLO; não tratar trecho ausente como zero.
        coverage_end = min(duration, float(t[-1]) + float(m['yolo_stride'])/float(m['fps']))
        events = events[events.time_sec.between(0, coverage_end)]
        r = dict(features=features, events=events, duration=coverage_end, game=str(m['game']),
                 split='teste' if str(m['game']) in test_games else 'treino')
        records[key] = r
        et = events.time_sec.to_numpy(float)
        starts = features.start_sec.to_numpy(float); starts = starts[starts > 0]
        sig = features[(features.duration_sec <= 8) & (features.zero_fraction >= .8) & (features['size'] >= 3)].start_sec.to_numpy(float)
        def window(a, b):
            v = players[(t >= a) & (t < b)]
            return dict(cuts=int(((starts >= a) & (starts < b)).sum()),
                        short_zero=int(((sig >= a) & (sig < b)).sum()),
                        zero_fraction=float((v == 0).mean()) if len(v) else np.nan,
                        players=float(v.mean()) if len(v) else np.nan)
        # Controle de 30s, sem anotação em ±60s do centro, mesma transmissão.
        centers = np.arange(60, coverage_end-60, 30.)
        clean = centers[np.array([not (np.abs(et-c) <= 60).any() for c in centers])]
        controls = [window(c-15, c+15) for c in clean]
        valid = events[events.time_sec.between(30, coverage_end-30)]
        before, after = [], []
        for ev in valid.itertuples():
            pre, post = window(ev.time_sec-30, ev.time_sec), window(ev.time_sec, ev.time_sec+30)
            before.append(pre); after.append(post)
            event_rows.append(dict(video_id=key, game=r['game'], label=ev.label, visibility=ev.visibility,
                                   time_sec=ev.time_sec, **{'pre_'+k:v for k,v in pre.items()}, **{'post_'+k:v for k,v in post.items()}))
            for offset in range(-30, 60, 5):
                if ev.time_sec+offset+5 <= coverage_end:
                    lag_rows.append(dict(video_id=key, game=r['game'], label=ev.label, lag_sec=offset,
                                         **window(ev.time_sec+offset, ev.time_sec+offset+5)))
        if after:
            for metric in ['cuts','short_zero','zero_fraction','players']:
                paired.append(dict(video_id=key, game=r['game'], metric=metric,
                                   pre=np.mean([x[metric] for x in before]), post=np.mean([x[metric] for x in after]),
                                   control=np.mean([x[metric] for x in controls]) if controls else np.nan,
                                   control_windows=len(controls)))
        quality.append(dict(video_id=key, game=r['game'], half=m['half'], height=m['height'],
                            duration_sec=duration, covered_sec=coverage_end, events=len(events), samples=len(samples),
                            zero_fraction=float((players==0).mean()), scenes=len(features), split=r['split']))
    paired = pd.DataFrame(paired)
    effects = []
    for metric, sub in paired.groupby('metric'):
        # Unidade de reamostragem é a partida (agrega tempos), nunca frames independentes.
        g = sub.groupby('game')[['pre','post','control']].mean()
        for baseline in ['pre','control']:
            delta = (g.post-g[baseline]).dropna().to_numpy()
            boot = rng.choice(delta, (2000,len(delta)), replace=True).mean(axis=1) if len(delta) else np.array([np.nan])
            effects.append(dict(metric=metric, baseline=baseline, matches=len(delta), difference=float(np.mean(delta)) if len(delta) else np.nan,
                                ci_low=float(np.nanquantile(boot,.025)), ci_high=float(np.nanquantile(boot,.975))))
    grid = []
    configs = []
    for short in [4,8,12]:
        for zero in [.5,.8,1.]:
            for cluster in [1,2]:
                config=dict(short=short,zero=zero,cluster=cluster)
                e,c = evaluate(records,config)
                score=scores(e,c,records,'treino')
                grid.append({**config,**score}); configs.append(config)
    grid = pd.DataFrame(grid)
    feasible=grid[grid.recall >= .9]
    best = feasible.sort_values('coverage').index[0] if len(feasible) else grid.assign(utility=grid.recall-grid.coverage*.5).sort_values('utility',ascending=False).index[0]
    config=configs[best]
    e,c=evaluate(records,config)
    ablations=[]
    for name,cfg in [('Regra escolhida',config),('Só cenas curtas',{**config,'use_zero':False}),('Exigir campo antes',{**config,'preceding':True}),('Cortes mais agrupados',{**config,'cluster':2})]:
        ae,ac=evaluate(records,cfg)
        for split in ['treino','teste']:
            ablations.append(dict(rule=name,**scores(ae,ac,records,split)))
    resolutions=[]
    for key,data in items.items():
        if 'error' not in data and not data.get('samples',pd.DataFrame()).empty:
            m=data['meta']; s=data['samples']
            resolutions.append(dict(video_id=key,game=m['game'],half=m['half'],height=m['height'],zero_fraction=s.player_count.eq(0).mean(),players=s.player_count.mean()))
    return dict(records=records, quality=pd.DataFrame(quality), events=pd.DataFrame(event_rows), lag=pd.DataFrame(lag_rows),
                paired=paired,effects=pd.DataFrame(effects),grid=grid,config=config,evaluation=e,clips=c,
                ablations=pd.DataFrame(ablations),resolutions=pd.DataFrame(resolutions),
                created=datetime.now().isoformat(timespec='seconds'), source_files=len(items))


def load_snapshot(root):
    items={}; errors=[]
    paths=sorted(root.rglob('*_analysis.xlsx'))
    for path in paths:
        try:
            from tcc_soccer_highlights.analysis_store import read_workbook
            sheets=read_workbook(path,root/'.dashboard_cache',sheet_names=['metadata','samples','scenes','events'])
            meta=sheets['metadata'].iloc[0].to_dict()
            if meta.get('status') != 'ok':
                continue
            items[str(meta['video_id'])]=dict(meta=meta,path=path,**sheets)
        except Exception as exc:
            errors.append(dict(path=str(path),error=str(exc)))
    return items,errors


def resolution_study(items, config):
    """Comparações no mesmo conteúdo e em timestamps presentes nas duas versões."""
    groups={}
    for key,d in items.items():
        m=d['meta']; group=(m['competition'],m['season'],m['game'],m['half'])
        groups.setdefault(group,{})[int(m['height'])]=(key,d)
    rows=[]; filter_rows=[]
    for group,versions in groups.items():
        if 224 not in versions or 720 not in versions: continue
        keylo,lo=versions[224]; keyhi,hi=versions[720]
        a=lo['samples'][['time_sec','player_count']].copy(); b=hi['samples'][['time_sec','player_count']].copy()
        pair=a.merge(b,on='time_sec',suffixes=('_224','_720'))
        if pair.empty: continue
        # Mesmo instante; 720p fornece referência operacional, não ground truth.
        open_view=pair.player_count_720.ge(6); close=pair.player_count_720.eq(0)
        end=min(float(lo['meta']['duration_sec']),float(hi['meta']['duration_sec']),float(pair.time_sec.max())+.2)
        ev=hi['events']; ev=ev[ev.time_sec.between(0,end)]
        post=np.zeros(len(pair),dtype=bool)
        for t in ev.time_sec: post |= pair.time_sec.between(t,t+30).to_numpy()
        sceneslo=lo['scenes'].start_sec.to_numpy(); sceneshi=hi['scenes'].start_sec.to_numpy()
        cutslo=sceneslo[sceneslo>0]; cutshi=sceneshi[sceneshi>0]
        matched=sum(bool((np.abs(cutshi-t)<=.5).any()) for t in cutslo)
        row=dict(game=group[2],half=group[3],samples=len(pair),open_samples=int(open_view.sum()),
                 players_224=pair.player_count_224.mean(),players_720=pair.player_count_720.mean(),
                 zero_224=pair.player_count_224.eq(0).mean(),zero_720=pair.player_count_720.eq(0).mean(),
                 zero_224_given_open720=pair.loc[open_view,'player_count_224'].eq(0).mean(),
                 agreement_zero=(pair.player_count_224.eq(0)==pair.player_count_720.eq(0)).mean(),
                 zero224_given_zero720=pair.loc[close,'player_count_224'].eq(0).mean(),
                 post_zero_224=pair.loc[post,'player_count_224'].eq(0).mean(),post_zero_720=pair.loc[post,'player_count_720'].eq(0).mean(),
                 processing_224=float(lo['meta']['processing_seconds']),processing_720=float(hi['meta']['processing_seconds']),
                 size_224=float(lo['meta']['file_size_mb']),size_720=float(hi['meta']['file_size_mb']),
                 cuts_224=len(cutslo),cuts_720=len(cutshi),cuts224_matched_720=matched/len(cutslo) if len(cutslo) else np.nan)
        rows.append(row)
        for height,key,d in [(224,keylo,lo),(720,keyhi,hi)]:
            features=scene_features(d)
            records={key:dict(features=features,events=ev,duration=end,game=group[2],split='pareado')}
            evaluation,clips=evaluate(records,config)
            filter_rows.append(dict(game=group[2],half=group[3],height=height,**scores(evaluation,clips,records,'pareado')))
    return pd.DataFrame(rows),pd.DataFrame(filter_rows)


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--root',type=Path,default=Path('analysis_output'))
    parser.add_argument('--output',type=Path,default=Path('reports/highlight_study'))
    args=parser.parse_args(); args.output.mkdir(parents=True,exist_ok=True)
    items,errors=load_snapshot(args.root)
    if not items: raise SystemExit('Nenhum arquivo completo com YOLO disponível.')
    result=study(items)
    result['resolution_pairs'],result['resolution_filter']=resolution_study(items,result['config'])
    for name,value in result.items():
        if isinstance(value,pd.DataFrame): value.to_csv(args.output/f'{name}.csv',index=False,encoding='utf-8-sig')
    manifest=dict(created=result['created'],source_files=result['source_files'],config=result['config'],targets=TARGETS,
                  errors=errors,files=[dict(path=str(d['path']),mtime=d['path'].stat().st_mtime,video_id=k) for k,d in items.items()])
    (args.output/'snapshot.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    from tcc_soccer_highlights.study_report import render_report
    render_report(result,args.output)
    print(json.dumps(dict(output=str(args.output),files=len(items),halves=len(result['quality']),games=result['quality'].game.nunique(),config=result['config']),ensure_ascii=False))


if __name__ == '__main__': main()
