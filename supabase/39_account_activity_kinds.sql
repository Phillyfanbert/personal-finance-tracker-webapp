-- ============================================================================
-- Two new account_activity kinds.
--
-- 'owed_adjust' - a direct correction to an account-linked liability's owed
-- balance. This reverses a previously deliberate rule (an account-linked
-- liability's balance moved ONLY through real dated expenses, never a typed
-- number), at the user's explicit request: a real statement is the source of
-- truth, and when the app's running total has drifted from it there was no
-- way to reconcile short of inventing fake charges. Logging every such
-- correction here is what keeps that safe - the edit stays visible in the
-- Log page's history and stays undoable, so an unexplained jump in a balance
-- can always be traced back to the moment someone typed it. Amount is a
-- SIGNED delta (positive = owed went up, negative = went down), matching
-- asset_adjust's convention exactly, so undoing it is the same "subtract
-- whatever the original delta was" operation regardless of direction.
--
-- 'account_created' - an audit breadcrumb for opening an account, so the
-- history log explains where an account came from. It is the first kind that
-- moves NO money: amount is always 0, and app.js gives it no undo affordance
-- (undoing it would mean silently deleting an account, which is what the
-- Accounts card's own delete button is for). logActivity()'s existing
-- "skip a zero amount" guard is bypassed for this kind specifically.
-- ============================================================================
alter table account_activity drop constraint account_activity_kind_check;
alter table account_activity add constraint account_activity_kind_check
  check (kind in ('asset_adjust','liability_payment','owed_adjust','account_created'));
