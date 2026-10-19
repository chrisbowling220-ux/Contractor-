You're keeping the tax numbers for the Safe-to-Spend calculator current (src/lib/setaside/taxYears/). Work on the master branch.

1. Check official sources for new or changed numbers:
   - IRS: income tax brackets and standard deduction (the yearly inflation-adjustment Revenue Procedure), standard mileage rate, estimated-tax due dates, and anything else the calculator uses.
   - SSA: Social Security wage base.
   - NCDOR: North Carolina income tax rate and standard deduction.
   Only use irs.gov, ssa.gov and ncdor.gov as the source of any number. Never blogs or news sites.
2. Compare what you find to every value in the tax year files.
   - If next year's numbers are officially published and that year's file doesn't exist, copy the latest year's file to the new year, update every number, and add tests for the new year in the same style as the existing ones.
   - If a number for an existing year officially changed (like a mid-year mileage rate change), update it.
   - Put the source URL in a comment next to every number you change.
3. Stop without changing anything if:
   - Nothing changed. Log "No changes" and exit without deploying.
   - Any number can't be confirmed on an official page, or official sources disagree.
   - A change would touch anything outside the tax year files and their tests.
4. Run the full test suite and the production build. If anything fails, undo your changes, don't deploy, and log exactly what failed.
5. If everything passes and DRY_RUN isn't set: commit with a message listing each changed number and its source, push to master, and redeploy hosting the same way it was deployed last time (see SETASIDE_REPORT.md). Don't redeploy Firestore rules. If the deploy errors with "is the current active version" but the live checks below pass, count it as a success.
6. After deploying, confirm https://builderspro.cc/safe-to-spend and https://builderspro.cc both return 200 and the page uses the right tax year. If a live check fails, put that at the top of the report in all caps.
7. Never touch Firestore rules, assetlinks.json, or anything unrelated to the set-aside tax numbers.
8. Append a dated entry to SETASIDE_UPDATES.md: what you checked, what changed (old value → new value, with source), test results, and whether you deployed.
