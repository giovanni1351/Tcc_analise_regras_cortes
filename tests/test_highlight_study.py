import unittest

import pandas as pd
import numpy as np

from tcc_soccer_highlights.highlight_study import canonical, evaluate, intervals, resolution_study, scene_features


class HighlightStudyTests(unittest.TestCase):
    def test_interval_union_and_video_bounds(self):
        f=pd.DataFrame({'duration_sec':[4,4,4], 'size':[5,5,5], 'zero_fraction':[1,1,1],
                        'previous_players':[10,10,10], 'start_sec':[5,30,110]})
        self.assertEqual(intervals(f,100),[[0.,55.]])

    def test_no_samples_does_not_mean_zero_players(self):
        d={'scenes':pd.DataFrame({'scene_id':[1,2], 'start_sec':[0,5], 'duration_sec':[4,4]}),
           'samples':pd.DataFrame({'scene_id':[1,1,1], 'time_sec':[0,1,2], 'player_count':[0,0,0]})}
        f=scene_features(d)
        self.assertTrue(pd.isna(f.loc[f.scene_id.eq(2),'zero_fraction'].iloc[0]))
        self.assertEqual(intervals(f,20),[[0.,20]])

    def test_highest_resolution_once_per_half(self):
        def item(height):
            return {'meta':{'competition':'x','season':'s','game':'g','half':1,'height':height},
                    'samples':pd.DataFrame({'player_count':[0]})}
        self.assertEqual(list(canonical({'low':item(224),'high':item(720)})),['high'])

    def test_annotations_do_not_change_proposals(self):
        f=pd.DataFrame({'duration_sec':[4], 'size':[5], 'zero_fraction':[1],
                        'previous_players':[10], 'start_sec':[40]})
        r={'v':{'features':f,'duration':100,'game':'g','split':'teste',
                'events':pd.DataFrame({'label':['Goal'],'time_sec':[40]})}}
        evaluation,first=evaluate(r,{})
        self.assertEqual(int(evaluation.hits.sum()),1)
        r['v']['events'].loc[0,'time_sec']=95
        evaluation,second=evaluate(r,{})
        pd.testing.assert_frame_equal(first,second)
        self.assertEqual(int(evaluation.hits.sum()),0)

    def test_vectorized_recall_matches_inclusive_reference(self):
        rng=np.random.default_rng(42)
        f=pd.DataFrame({'duration_sec':rng.integers(1,20,70),'size':5,'zero_fraction':rng.random(70),
                        'previous_players':rng.integers(0,20,70),'start_sec':np.sort(rng.uniform(0,1000,70))})
        events=pd.DataFrame({'label':'Goal','time_sec':np.r_[rng.uniform(0,1000,100),0.,1000.]})
        r={'v':{'features':f,'duration':1000,'game':'g','split':'teste','events':events}}
        for config in [dict(short=12,zero=.5),dict(short=4,zero=1),dict(short=8,cluster=2),dict(short=12,preceding=True)]:
            spans=intervals(f,1000,**config)
            events.loc[len(events)]=['Goal',spans[0][0] if spans else 0.]
            events.loc[len(events)]=['Goal',spans[0][1] if spans else 1000.]
            expected=sum(any(a<=t<=b for a,b in spans) for t in events.time_sec)
            actual,_=evaluate(r,config)
            self.assertEqual(int(actual.hits.sum()),expected)


if __name__ == '__main__': unittest.main()
