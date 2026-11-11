# Cégadat API fixtures

Captured 2026-10-01 from `https://api.cegadatapi.hu` (API v1.4, 2026-02-05)
with the test key published in the provider's documentation, then scrubbed:
private persons' names (managers, owners, sole traders) are replaced with
"Teszt Személy N", sole traders' street addresses with "Minta utca", and bank
account numbers are zeroed. Company names, activity codes and financials are
public registry data and are kept as returned.

`detail-99999999242.json` is SYNTHETIC — none of the six test companies has a
website, phone or email, so the contact-field mapping is exercised against a
fixture shaped like the documented example. The `error-*` files are the
documented error bodies.

`detail-99999998241.json` is SYNTHETIC too: a micro company in Budapest with
a registry email address, a comma and accents in its name, and a (zeroed)
bank account. None of the six real test companies is a micro Budapest company
with an email, so the Company Finder's verification filter needs it to have
something to return. Its first name-search hit for "Árvíztűrő" is served by the
test stub, not by the API.
