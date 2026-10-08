# Rodar o treinamento
```bash
uv run python -m tcc_soccer_highlights.batch_analysis --model best.pt --batch-size 16 --skip-existing
```
# Rodar o dashboard para as analises
```bash
uv run streamlit run src/tcc_soccer_highlights/dashboard.py
```


