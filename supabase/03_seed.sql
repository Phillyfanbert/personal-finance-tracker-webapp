-- ============================================================================
-- Personal Expense Tracker - Phase 0 Seed Data (optional, README §3.7 / F6)
-- Run this THIRD. Populates subscription_catalog with common plans so the
-- discount-discovery feature (Phase 4) has reference data to match against.
--
-- ⚠️  PRICES CHANGE OFTEN. Treat these as starting placeholders and verify /
--     update them against each service's official pricing page before relying
--     on discount suggestions. Amounts are USD, monthly-equivalent unless the
--     plan_type is 'annual' (then price is the annual charge).
-- ============================================================================

insert into subscription_catalog (service, plan_type, price, eligibility, url, notes) values
  ('Spotify',       'individual', 11.99,  'anyone',                      'https://www.spotify.com/us/premium/', 'baseline individual plan'),
  ('Spotify',       'student',     5.99,  'verified student (SheerID)',  'https://www.spotify.com/us/student/', 'includes Hulu ad-supported in US'),
  ('Spotify',       'family',     19.99,  'up to 6 members, same address','https://www.spotify.com/us/premium/', 'best per-head value for households'),
  ('YouTube Premium','individual',13.99,  'anyone',                      'https://www.youtube.com/premium',     'ad-free + background play'),
  ('YouTube Premium','student',    7.99,  'verified student',            'https://www.youtube.com/premium/student', NULL),
  ('YouTube Premium','family',    22.99,  'up to 5 family members',      'https://www.youtube.com/premium',     NULL),
  ('Adobe CC',      'individual', 59.99,  'anyone',                      'https://www.adobe.com/creativecloud/plans.html', 'All Apps plan'),
  ('Adobe CC',      'student',    19.99,  'students & teachers, yr 1',   'https://www.adobe.com/creativecloud/buy/students.html', 'first-year promo; higher after'),
  ('Netflix',       'individual', 17.99,  'anyone',                      'https://www.netflix.com/signup', 'Standard, no ads'),
  ('Netflix',       'annual',      NULL,  'no annual plan offered',      'https://www.netflix.com/signup', 'monthly only'),
  ('iCloud+',       'individual',  2.99,  'anyone',                      'https://www.apple.com/icloud/', '200GB tier'),
  ('iCloud+',       'family',      2.99,  'Family Sharing, up to 6',     'https://www.apple.com/icloud/', 'shareable at no extra cost'),
  ('Amazon Prime',  'individual', 14.99,  'anyone',                      'https://www.amazon.com/prime', NULL),
  ('Amazon Prime',  'annual',    139.00,  'anyone',                      'https://www.amazon.com/prime', 'cheaper per month than monthly'),
  ('Amazon Prime',  'student',     7.49,  'verified student, Prime Student','https://www.amazon.com/student', '6-month free trial then 50% off')
on conflict do nothing;
