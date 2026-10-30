from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import pandas as pd
from streamlit.testing.v1 import AppTest


class DashboardLoadingTests(unittest.TestCase):
    def test_open_only_loads_selected_video_and_refresh_only_indexes_new_metadata(self):
        with TemporaryDirectory(prefix='tmp_dashboard_',dir=Path(__file__).parent) as tmp:
            root=Path(tmp).resolve()
            def write(number):
                with pd.ExcelWriter(root/f'{number}_analysis.xlsx') as writer:
                    pd.DataFrame([dict(video_id=f'video{number}',duration_sec=10,processing_seconds=1)]).to_excel(
                        writer,sheet_name='metadata',index=False)
                    pd.DataFrame(dict(time_sec=[0.,1.,2.],player_count=[1,2,3],near_event=[True,False,False])).to_excel(
                        writer,sheet_name='samples',index=False)
                    pd.DataFrame(dict(scene_id=[1],start_sec=[0.],end_sec=[10.],duration_sec=[10.])).to_excel(
                        writer,sheet_name='scenes',index=False)
                    pd.DataFrame(dict(label=['Goal'],time_sec=[1.])).to_excel(writer,sheet_name='events',index=False)
                    pd.DataFrame().to_excel(writer,sheet_name='event_windows',index=False)
                    pd.DataFrame().to_excel(writer,sheet_name='scene_summary',index=False)
            for number in range(6):
                write(number)
            source=(Path(__file__).parents[1]/'src/tcc_soccer_highlights/dashboard.py').read_text(encoding='utf-8')
            source=source.replace('OUTPUT_ROOT = Path("analysis_output")',f'OUTPUT_ROOT = Path({str(root)!r})')
            app=AppTest.from_string(source,default_timeout=60)
            with patch('tcc_soccer_highlights.analysis_store.pd.read_excel',wraps=pd.read_excel) as reader:
                app.run()
                self.assertFalse(app.exception)
                self.assertEqual(sum(call.kwargs.get('sheet_name') is None for call in reader.call_args_list),1)
                self.assertEqual(sum(call.kwargs.get('sheet_name') == ['metadata'] for call in reader.call_args_list),6)
                reader.reset_mock()
                app.sidebar.selectbox[0].set_value('video1').run()
                self.assertFalse(app.exception)
                self.assertEqual(sum(call.kwargs.get('sheet_name') is None for call in reader.call_args_list),1)
                reader.reset_mock()
                app.sidebar.radio[0].set_value('Relatório do estudo').run()
                self.assertFalse(app.exception)
                reader.assert_not_called()
                write(6)
                app.sidebar.button[0].click().run()
                self.assertFalse(app.exception)
                self.assertEqual(reader.call_count,1)
                self.assertEqual(reader.call_args.kwargs['sheet_name'],['metadata'])
            # Uma sessão anterior ao índice novo mantém o módulo antigo em memória.
            from tcc_soccer_highlights import analysis_store
            del analysis_store.read_metadata_index
            app.run()
            self.assertFalse(app.exception)
            self.assertTrue(callable(analysis_store.read_metadata_index))


if __name__ == '__main__':
    unittest.main()
