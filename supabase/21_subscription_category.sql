-- Free-text category on a recurring subscription/bill. Deliberately no
-- CHECK constraint (unlike accounts.type/assets.type/liabilities.type): a bill
-- can be anything from "Utilities" to "Kid's piano lessons" and the user
-- should be able to type any label rather than being boxed into a fixed
-- enum. app.js seeds a datalist of common suggestions but does not
-- validate against it, the same UX pattern already used for
-- accounts.bank_name.
alter table subscriptions add column if not exists category text;
