/**
 * Mock inbox data for the Triage scaffold.
 *
 * LIVE_MODE (future): this module will be replaced by a Gmail data source.
 * The plan is OAuth 2.0 in the Quest browser (standard Google web OAuth flow,
 * redirect back to the hosted app) → Gmail API `users.messages.list` for
 * unread mail → `users.messages.get` for sender/subject/snippet. Triage
 * actions map to Gmail calls: archive = removeLabelIds ["INBOX"],
 * delete = users.messages.trash, keep-for-today = addLabelIds ["TODAY"] or
 * snooze. The TriageSystem consumes `Email[]` only, so swapping this module
 * for a live fetch should not touch gesture code.
 */

export interface Email {
  id: string;
  sender: string;
  /** Fictional address used only by the sample composer. */
  senderAddress: string;
  subject: string;
  /** 2–3 line preview shown on the card face. */
  preview: string;
  /** Full body shown when the card is grabbed/expanded. */
  body: string;
  date: string;
  /** Hint for the "correct" triage call — used for a future scoring mode. */
  idealAction: 'archive' | 'delete' | 'today';
}

export const MOCK_INBOX: Email[] = [
  {
    id: 'm1',
    senderAddress: 'sara@family.example',
    sender: 'Sara Miller',
    subject: 'Re: Camden’s birthday — Saturday headcount',
    preview:
      'Mom just confirmed she’s flying in Friday night.\nCan you grab the cake on your way home Thursday?',
    body: 'Mom just confirmed she’s flying in Friday night, so we’ll have 14 for dinner Saturday. Can you grab the cake on your way home Thursday? Chocolate, obviously. — Sara',
    date: '8:42 AM',
    idealAction: 'today',
  },
  {
    id: 'm2',
    senderAddress: 'glenn@plandynamic.example',
    sender: 'Glenn Brown, PlanDynamic',
    subject: 'Your financial plan draft is ready to review',
    preview:
      'I’ve uploaded the first draft of your plan to the portal.\nLet’s walk through it on our call Thursday.',
    body: 'Hi Hanlon — I’ve uploaded the first draft of your financial plan to the eMoney portal. The cash-flow section has two scenarios I want your take on. Let’s walk through it on our call Thursday at 2pm. — Glenn',
    date: '8:15 AM',
    idealAction: 'today',
  },
  {
    id: 'm3',
    senderAddress: 'notifications@github.example',
    sender: 'GitHub',
    subject: '[soothslayer/call-me] PR #1 approved',
    preview:
      'wes approved pull request #1: feat/codex-and-cli.\n2 checks passed — ready to merge.',
    body: 'wes approved your pull request soothslayer/call-me#1 (feat/codex-and-cli). All 2 checks have passed. You can merge whenever you’re ready.',
    date: '7:58 AM',
    idealAction: 'archive',
  },
  {
    id: 'm4',
    senderAddress: 'travel@southwest.example',
    sender: 'Southwest Airlines',
    subject: 'Your trip is in 73 days — check in soon',
    preview:
      'Just a reminder: your Dec 22 flight to Nashville\nis coming up. Add it to your calendar.',
    body: 'Just a reminder: your December 22 flight from BOS to BNA is 73 days away. We’ll email you when check-in opens. Want to add early boarding while it’s cheap?',
    date: '7:30 AM',
    idealAction: 'archive',
  },
  {
    id: 'm5',
    senderAddress: 'updates@linkedin.example',
    sender: 'LinkedIn',
    subject: 'You appeared in 12 searches this week',
    preview:
      'Recruiters are looking at your profile.\nSee who’s hiring Azure engineers in Boston.',
    body: 'Your profile appeared in 12 searches this week. Recruiters from 3 companies viewed your Azure authentication experience. Upgrade to Premium to see names.',
    date: '6:55 AM',
    idealAction: 'delete',
  },
  {
    id: 'm6',
    senderAddress: 'orders@bambu.example',
    sender: 'Bambu Lab',
    subject: 'Your order has shipped',
    preview:
      'Good news — 2x PLA Matte Black is on its way.\nTracking: 1Z8842W00344120987.',
    body: 'Good news! Your order of 2× Bambu PLA Matte (1kg spools) has shipped via UPS. Tracking: 1Z8842W00344120987. Estimated delivery: Tuesday.',
    date: '6:12 AM',
    idealAction: 'archive',
  },
  {
    id: 'm7',
    senderAddress: 'coach@soccer.example',
    sender: 'Coach Tremble',
    subject: 'Saturday soccer — field change',
    preview:
      'Heads up: Saturday’s game moved to Field 3\nbehind the school. Same time, 9 AM.',
    body: 'Heads up, parents: Saturday’s in-town game has moved to Field 3 behind Stapleton Elementary (drainage work on Field 1). Same time — 9 AM kickoff, please arrive by 8:40. — Coach Tremble',
    date: 'Yesterday',
    idealAction: 'today',
  },
  {
    id: 'm8',
    senderAddress: 'plans@bestbuy.example',
    sender: 'Best Buy',
    subject: 'Your Geek Squad protection plan renews soon',
    preview:
      'Your plan for the Samsung Frame TV renews\nNov 2 for $129.99. No action needed.',
    body: 'Your Geek Squad protection plan for the 55" Samsung Frame TV renews automatically on November 2 for $129.99. No action needed — or cancel anytime before then in your account.',
    date: 'Yesterday',
    idealAction: 'archive',
  },
  {
    id: 'm9',
    senderAddress: 'no-reply@deals.example',
    sender: 'no-reply@deals.example',
    subject: 'FLASH SALE: 70% off extended 2 hours!!',
    preview:
      'You won’t believe these prices…\nUnsubscribe at any time.',
    body: 'FLASH SALE EXTENDED!! 70% off everything for 2 more hours. You won’t believe these prices. Click here now now now. (You received this because you once bought socks in 2019.)',
    date: 'Yesterday',
    idealAction: 'delete',
  },
  {
    id: 'm10',
    senderAddress: 'vrstart@meta.example',
    sender: 'Meta VR Start',
    subject: 'Submission checklist — 39 days left',
    preview:
      'Your Devpost draft is saved. Don’t forget:\nhosted build link + 3-minute demo video.',
    body: 'Hi Hanlon — your Devpost draft for the VR Start competition is saved. With 39 days left, don’t forget the two hard requirements: a hosted playable WebXR link and a demo video under 3 minutes. Builds must stay live through judging.',
    date: 'Yesterday',
    idealAction: 'today',
  },
  {
    id: 'm11',
    senderAddress: 'pto@school.example',
    sender: 'Stapleton Elementary PTO',
    subject: 'Fall Festival volunteers — thank you!',
    preview:
      'Thanks to everyone who helped Saturday.\nWe raised $4,200 for new library books!',
    body: 'A huge thank you to all 38 volunteers at Saturday’s Fall Festival! Together we raised $4,200 for new library books. Photos are in the shared album. See you at the winter concert!',
    date: 'Oct 8',
    idealAction: 'archive',
  },
  {
    id: 'm12',
    senderAddress: 'statements@chase.example',
    sender: 'Chase',
    subject: 'Your statement is ready',
    preview:
      'Your Sapphire Reserve statement closed Oct 7.\nBalance: $2,314.08. Payment due Oct 28.',
    body: 'Your Chase Sapphire Reserve statement closed on October 7. Statement balance: $2,314.08. Minimum payment $46.00, due October 28. Autopay is ON for the full balance.',
    date: 'Oct 8',
    idealAction: 'archive',
  },
  {
    id: 'm13',
    senderAddress: 'trades@fidelity.example',
    sender: 'Fidelity',
    subject: 'Trade confirmation: VTI buy order filled',
    preview:
      'Your order to buy 4 shares of VTI\nfilled at $312.44/share.',
    body: 'Your market order to buy 4 shares of Vanguard Total Stock Market ETF (VTI) has been filled at $312.44 per share, for a total of $1,249.76. Settlement: Oct 13.',
    date: 'Oct 7',
    idealAction: 'archive',
  },
  {
    id: 'm14',
    senderAddress: 'mom@family.example',
    sender: 'Mom',
    subject: 'That lawyer letter',
    preview:
      'Honey, the lawyer’s office called again.\nCan you look at the letter tonight?',
    body: 'Honey — the lawyer’s office called again about the settlement letter. I still can’t find the email on my phone. Can you look at it with me tonight? Don’t want to sign anything wrong. Love, Mom',
    date: 'Oct 7',
    idealAction: 'today',
  },
  {
    id: 'm15',
    senderAddress: 'offers@oldnavy.example',
    sender: 'Old Navy',
    subject: 'We miss you! 40% off inside',
    preview:
      'It’s been a while… come back and save.\nOnline only, ends Sunday.',
    body: 'We miss you! Here’s 40% off your next online order, because our algorithm noticed you haven’t clicked in 214 days. Ends Sunday at midnight. Please validate our life choices.',
    date: 'Oct 6',
    idealAction: 'delete',
  },
];
