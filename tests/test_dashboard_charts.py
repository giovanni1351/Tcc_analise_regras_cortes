import unittest
import pandas as pd
from tcc_soccer_highlights.dashboard_charts import timeline_chart


class TimelineTests(unittest.TestCase):
    def test_timeline_preserves_signals_scene_bounds_and_event_markers_in_both_rows(self):
        data = dict(samples=pd.DataFrame(dict(time_sec=[0., 2., 5.], player_count=[1, 3, 0])),
                    scenes=pd.DataFrame(dict(scene_id=[1, 2], start_sec=[0., 2.], end_sec=[2., 5.], duration_sec=[2., 3.])),
                    events=pd.DataFrame(dict(label=['Goal', 'Corner'], time_sec=[1., 4.])))
        fig = timeline_chart(data, ['player_count'], ['Goal'])
        self.assertEqual(len(fig.data), 2)
        self.assertEqual(list(fig.data[0].y), [1, 3, 0])
        self.assertEqual(list(fig.data[1].base), [0., 2.])
        self.assertEqual(list(fig.data[1].x), [2., 3.])
        self.assertEqual(fig.data[1].customdata.tolist(), [[1., 0., 2.], [2., 2., 5.]])
        self.assertEqual([(s.x0, s.x1, s.xref, s.yref) for s in fig.layout.shapes],
                         [(1., 1., 'x', 'y domain'), (1., 1., 'x2', 'y2 domain')])
        self.assertEqual([a.text for a in fig.layout.annotations], ['Goal'])
        self.assertNotEqual(fig.data[1].marker.color[0], fig.data[1].marker.color[1])
        fig.to_json()

    def test_empty_timeline_renders_without_events_or_scenes(self):
        fig = timeline_chart({}, [], [])
        self.assertEqual(len(fig.data), 0)
        self.assertEqual(len(fig.layout.shapes), 0)
        fig.to_json()
