-- Companion to price_symbol (26_asset_price_findings.sql) - a per-share/
-- per-coin price alone isn't a total dollar value without knowing how many
-- units are held. numeric(18,8): crypto needs many decimal places (e.g.
-- 0.00000001 BTC), a plain share count doesn't. Applying a price finding
-- with no quantity set would silently set an asset's total value to a
-- single share's price, which is wrong for any holding of more than one
-- unit - the client refuses to Apply until quantity is set (see app.js),
-- rather than guessing 1.
alter table assets add column if not exists quantity numeric(18,8);
