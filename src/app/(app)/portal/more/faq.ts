/**
 * The Help / FAQ content (spec §3.5). Static on purpose — it is the same
 * eleven questions for every customer, it needs no admin screen, and it
 * genuinely reduces calls: nine of these are what the office answers on the
 * phone all day.
 *
 * Written in plain language and honest about timescales. A FAQ that promises
 * 'usually two weeks' when the city takes six creates the call it was meant to
 * prevent.
 */
export const FAQ: Array<{ q: string; a: string }> = [
  {
    q: 'How long does the whole process take?',
    a: 'Most projects run three to five months from signing to switch-on. The single biggest variable is the city permit and the utility approval, and neither is in our hands — which is why your stage tracker shows where your paperwork actually is rather than a countdown.',
  },
  {
    q: 'Why is nothing happening on my project this week?',
    a: 'Between submitting a permit and hearing back, there is genuinely nothing to do but wait. Your project has not been forgotten — if the stage tracker says "under review by the city", that is exactly where it is.',
  },
  {
    q: 'Do I need to be home for the site survey?',
    a: 'Yes, please. The surveyor needs access to your electrical panel, your attic or loft space, and the roof. It usually takes one to two hours.',
  },
  {
    q: 'Do I need to be home for the installation?',
    a: 'Someone over 18 should be there at the start and end of the day. The crew needs access to your panel and a clear route to the roof — moving cars off the driveway the night before helps a lot.',
  },
  {
    q: 'Will my power be off during the installation?',
    a: 'Briefly, usually an hour or two while the crew connects your system to your panel. They will tell you before they switch anything off.',
  },
  {
    q: 'My panels are on the roof — why is my system not producing yet?',
    a: 'Because the utility has not given permission to operate yet. It is illegal and unsafe to export power before that approval, so the system stays switched off until the inspection has passed and the utility says yes. That step is the last one on your tracker.',
  },
  {
    q: 'When do I pay, and how much?',
    a: 'Exactly what your agreement says — usually a deposit, one or two milestone payments, and a final payment at completion. The Project tab shows each one and whether we have received it.',
  },
  {
    q: 'What is an adder, and can it change my price?',
    a: 'An adder is extra work found on site — a main panel upgrade, a re-roof, longer conduit runs. Nothing is added to your total without your written approval first, and anything you have approved appears in your project total.',
  },
  {
    q: 'How do I claim the tax credit?',
    a: 'Your accountant will want your final invoice and your permission-to-operate letter. Both are in your Documents tab, and once your project is complete you can download the whole pack as one file.',
  },
  {
    q: 'How do I know how much my system is producing?',
    a: 'Your inverter manufacturer provides a monitoring app, and the crew will set it up with you on installation day. That app is the accurate source for production figures.',
  },
  {
    q: 'Who do I call if something is wrong with my system?',
    a: 'Call us first, whatever it is. Your project manager is on the Home tab, and if it turns out to be a warranty matter with the equipment we will handle it with the manufacturer for you.',
  },
];
