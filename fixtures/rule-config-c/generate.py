import json, pathlib, sys, time
import pandas as pd
sys.path.insert(0, str(pathlib.Path.cwd()/'src'))
from tcc_soccer_highlights.highlight_study import scene_features, intervals
root=pathlib.Path('analysis_output')
out=pathlib.Path('/tmp/claude-1000/-home-pedro--t3-worktrees-Tcc_analise_regras_cortes-t3-520878a9-4c6aa0391d45c2a5/8d01ab28-a370-45ba-9943-2a5d07456776/scratchpad/research/rule-fixtures')
config=json.loads(pathlib.Path('saved_rules/configurations.json').read_text())['configurations'][2]['config']
paths=sorted(root.rglob('*_analysis.xlsx'))
for i,path in enumerate(paths[:3]):
 t=time.monotonic(); sheets=pd.read_excel(path,sheet_name=['metadata','scenes','samples']); meta=sheets['metadata'].iloc[0]; samples=sheets['samples']; scenes=sheets['scenes']; duration=min(float(meta['duration_sec']),float(samples.time_sec.max())+float(meta.yolo_stride)/float(meta.fps)); windows=intervals(scene_features(sheets),duration,**config)
 data={'source':str(path),'metadata':{'duration_sec':float(meta.duration_sec),'fps':float(meta.fps),'yolo_stride':int(meta.yolo_stride),'coverage_end':duration},'config':config,'scenes':json.loads(scenes[['scene_id','start_sec','duration_sec']].to_json(orient='records',double_precision=15)),'samples':json.loads(samples[['scene_id','time_sec','player_count']].to_json(orient='records',double_precision=15)),'windows':windows}
 (out/f'fixture-{i+1}.json').write_text(json.dumps(data,ensure_ascii=False,allow_nan=False)); print(path,len(scenes),len(samples),len(windows),round(time.monotonic()-t,2),flush=True)
