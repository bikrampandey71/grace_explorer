GRACE Explorer V30 — Interface-only update (no NetCDF rebuilding)

Based on V29. The following are the ONLY behavioral changes:
1. Public time-series trend-value chips move below the plot and explanatory note.
2. The trend-value chips wrap naturally without an inner scroll bar.
3. Tonle Sap Basin is hidden from map interaction and region dropdowns.
   Its scientific data remain untouched in data/series.js and boundaries.js.
4. Level-2 administrative boundaries appear light magenta rather than light green.
   Cyan hover animation and selected-region highlighting are unchanged.

FAST UPDATE (no Python required):
- Copy app.js, index.html, and style.css into:
  C:\Users\bikra\Desktop\GRACE\GRACE_MCD_dashboard\dashboard\grace_site\
- Refresh with Ctrl+F5.
- For permanent source edits, copy those same three files into dashboard\web\.
- On GitHub Pages, replace the files in the published site root and commit.
- Do not delete or replace the data/ folder.

No scientific processing, trend computation, basemap or zoom code was changed.
