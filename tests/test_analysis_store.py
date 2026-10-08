import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pandas as pd

from tcc_soccer_highlights.analysis_store import read_workbook


class AnalysisStoreTests(unittest.TestCase):
    def test_cached_parquet_matches_excel_and_skips_excel_reader(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            frame=pd.DataFrame({'time_sec':[0.,.2,.4],'player_count':[0,2,3],'label':['Goal','Foul',None]})
            frame.to_excel(source,index=False,sheet_name='samples')
            first=read_workbook(source,root/'cache')
            with patch('tcc_soccer_highlights.analysis_store.pd.read_excel',side_effect=AssertionError('Excel relido')):
                second=read_workbook(source,root/'cache')
            pd.testing.assert_frame_equal(first['samples'],second['samples'])

    def test_changed_source_invalidates_cache(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            pd.DataFrame({'player_count':[0]}).to_excel(source,index=False,sheet_name='samples')
            read_workbook(source,root/'cache')
            pd.DataFrame({'player_count':[12,13]}).to_excel(source,index=False,sheet_name='samples')
            fresh=read_workbook(source,root/'cache')
            self.assertEqual(fresh['samples'].player_count.tolist(),[12,13])

    def test_incomplete_workbook_is_not_published(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as tmp:
            root=Path(tmp); source=root/'sample.xlsx'
            pd.DataFrame({'player_count':[0]}).to_excel(source,index=False)
            with patch('tcc_soccer_highlights.analysis_store.fingerprint',side_effect=[(1,2),(3,4)]):
                with self.assertRaises(OSError): read_workbook(source,root/'cache')
            self.assertFalse(list((root/'cache').rglob('manifest.json')))
