# Meta Developer Approval and Suspension-Prevention Guide

This guide describes what Meta requires to take GlassPost live and how to reduce the risk of your developer account or app being restricted. No one outside Meta can approve an app or guarantee it will not be restricted. Meta makes both decisions, and community reports show restrictions sometimes arrive with little explanation. Follow this guide to give your submission the best chance.

## 1. Decide which access level you need

| Goal | Access level | App Review | Business Verification |
| --- | --- | --- | --- |
| Schedule posts only for Instagram accounts you own or manage (you, your team, your clients added as app roles) | Standard Access | Not required | Not required for role users |
| Let the general public connect their own accounts | Advanced Access | Required | Required |

**Recommendation:** launch with Standard Access first. Add your Instagram Professional accounts as testers or role users and use GlassPost for your own work. This needs no review, which removes the most common trigger for enforcement activity. Apply for Advanced Access only when you are ready to serve outside users.

## 2. Rules that protect your account

1. **Never create a new developer account or app to get around a restriction.** Meta's Platform Term 7.e.i.3 prohibits apps intended to circumvent enforcement, and this is one of the most frequently reported reasons for a permanent ban. Appeal the existing restriction instead.
2. **Keep the app reachable and testable.** Meta's compliance reviews restrict apps that reviewers cannot access. Keep the site online, keep the sign-in flow working, and keep test credentials valid. On Koyeb free, keep the one-minute scheduler ping running so the instance is never asleep during a review.
3. **Request only the permissions you use**, and use them exactly as described in your submission. Do not change what the app does after approval without updating the review.
4. **Protect your Facebook identity.** Use one real, verified identity, enable two-factor authentication, and avoid logging in from unusual locations or through VPNs. Community reports link account security locks to sudden developer-account restrictions.
5. **Monitor alerts.** Check the app dashboard Alerts inbox and the business email set in Developer Settings. Respond to every Required Action before its deadline.
6. **Complete Data Use Checkup** when Meta asks for it each year.
7. **Follow branding rules.** Do not put "Instagram", "Insta" or "IG" in the app name. Use the Instagram logo only as Meta's Logos and Trademarks guidelines allow, and keep the "Not affiliated with Instagram or Meta" notice.
8. **Handle data correctly.** Keep the privacy policy, terms and data deletion URL live and accurate, and keep the deauthorize and data deletion callbacks working (GlassPost includes them).
9. **Never share, sell or scrape tokens or user data**, and do not give app access to third parties you have not disclosed.

## 3. Pre-submission checklist

- [ ] Business Verification completed for the business that owns the app (required before you can publish the app and before Advanced Access)
- [ ] Business name, address, phone and website match your legal documents exactly
- [ ] App icon, category, privacy policy URL, terms URL and data deletion URL set in App settings, Basic
- [ ] Valid OAuth redirect URI, deauthorize URL and data deletion URL set in Business login settings
- [ ] At least one successful API call per requested permission (Meta requires this before requesting Advanced Access)
- [ ] The site loads without VPN or login walls, other than Instagram sign-in
- [ ] A dedicated Instagram Professional test account with sample content, whose credentials you provide to reviewers
- [ ] Screencast recorded for each permission (script in section 5)

## 4. Text to paste into the review form

**instagram_business_basic**
> GlassPost is a scheduling tool for Instagram Professional accounts. After the account owner signs in with Business Login for Instagram, we use instagram_business_basic to read their account ID, username, account type and profile picture. We show the username and picture in the dashboard so the user can confirm which account is connected. We do not use this data for any other purpose.

**instagram_business_content_publish**
> GlassPost lets the account owner upload a photo or Reel, write a caption and choose a publish time. At that time we call the Content Publishing API (create media container, then media_publish) to publish exactly that post to the same account. Nothing is published without an explicit scheduling action by the user, and users can cancel any scheduled post before it is published.

**Reviewer instructions**
> 1. Open https://app.yourdomain.com and select "Connect Instagram".
> 2. Sign in with the test Instagram Professional account provided below and approve the permissions.
> 3. In the dashboard choose Photo, upload a JPEG, add a caption and set a time about 3 minutes ahead, then select "Schedule post".
> 4. The post appears in the Queue as Scheduled, changes to Published at the chosen time, and a "View" link opens it on Instagram.
> 5. To remove data, use Sign out, or remove GlassPost in Instagram under Settings, Apps and websites, which triggers our deletion callback.
> Test account: (username and password here)

## 5. Screencast script (one video per permission, English captions or narration)

1. Landing page with the visible "Connect Instagram" button and the legal links.
2. Click the button and show Instagram's permission screen with the requested permissions visible. Do not blur or skip it.
3. Approve and show the dashboard with the connected username (instagram_business_basic).
4. Upload a JPEG, type a caption, schedule 2 to 3 minutes ahead (instagram_business_content_publish).
5. Show the Queue status changing from Scheduled to Published, then open the post on instagram.com or the Instagram app.
6. Show Sign out and the Data deletion page.
Keep it under 4 minutes, record at readable resolution, and show the browser address bar throughout.

## 6. If you are rejected or restricted

1. Read the exact reason in the dashboard (App Review, Requests) and fix that item only.
2. Resubmit with the fix explained in the notes. Avoid resubmitting an unchanged request repeatedly.
3. For a restriction, use the appeal link in the dashboard or Get Developer Support, and include the app ID, the policy cited and a factual explanation.
4. Do not create new accounts or apps while an appeal is open (see rule 1).
