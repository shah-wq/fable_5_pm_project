# End-to-end suites

Each script boots its own PostgreSQL and its own `next start`, on its own ports,
applies every migration the way the SQL editor applies them — one script, one
transaction — and then drives the running app with curl.

They live in the repository rather than in a scratch directory because a scratch
directory gets cleared, and a regression suite that only exists on one machine
is a regression suite you do not have.

    bash scripts/e2e/crm-foundation.sh   # migrations 003300/003400, as the database sees them
    bash scripts/e2e/people.sh           # module 16, through the running app
    bash scripts/e2e/stage-attachments.sh  # stage attachments in place of Drive Updated
    bash scripts/e2e/esign.sh            # PandaDoc contracts and change orders, against a mock
    bash scripts/e2e/assistant.sh        # Ask SolarFlow, against a stand-in for the Claude API
    bash scripts/e2e/notifications.sh    # the notification catalogue, triggers, timed rules, feeds

Run them one at a time: they each bind a port, and two at once will fight over
PostgreSQL's socket directory.
