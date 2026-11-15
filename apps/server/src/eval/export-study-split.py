import json
import re
import sys
from pathlib import Path
from zipfile import ZipFile
from xml.etree import ElementTree as ET

ns = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
chosen = {}
root = Path(sys.argv[1] if len(sys.argv) > 1 else "analysis_output")
for path in sorted(root.rglob("*_analysis.xlsx")):
    with ZipFile(path) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        sheets = {sheet.attrib["name"]: f"xl/worksheets/sheet{sheet.attrib['sheetId']}.xml"
                  for sheet in workbook.findall("s:sheets/s:sheet", ns)}
        metadata = ET.fromstring(archive.read(sheets["metadata"]))
        rows = metadata.findall("s:sheetData/s:row", ns)
        def values(row):
            return [cell.findtext("s:is/s:t", namespaces=ns) if cell.attrib.get("t") == "inlineStr"
                    else cell.findtext("s:v", namespaces=ns) for cell in row]
        meta = dict(zip(values(rows[0]), values(rows[1])))
        with archive.open(sheets["samples"]) as samples:
            prefix = samples.read(4096).decode()
        dimension = re.search(r'<dimension ref="[^"]*?(\d+)"', prefix)
        if not dimension or int(dimension[1]) < 2:
            continue
        scenes = ET.fromstring(archive.read(sheets["scenes"]))
        count = len(scenes.findall("s:sheetData/s:row", ns)) - 1
        key = (meta["competition"], meta["season"], meta["game"], int(meta["half"]))
        item = dict(league=key[0], season=key[1], game=key[2], half=key[3],
                    resolution=f'{int(float(meta["height"]))}p',
                    duration=float(meta["duration_sec"]), scenes=count,
                    workbook=str(path.relative_to(root)))
        if key not in chosen or float(meta["height"]) > int(chosen[key]["resolution"][:-1]):
            chosen[key] = item
print(json.dumps(list(chosen.values()), ensure_ascii=False, indent=2))
