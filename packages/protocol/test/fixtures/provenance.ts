// The provenance fixtures: the coach's draft, and the page after the writer worked on it. A paragraph was inserted
// in the middle, two words were added to one coach paragraph, and one was rewritten until most of it is new.

export const BASELINE = `## The lid is a chaos monkey

I closed the laptop at six and the build died with it. Nobody told the runtime that a lid is a normal thing to close.

The runtimes I have read do something cheaper. They retry the call and carry on as if nothing happened.

On wake, the daemon reconciles what it thinks is running with what is running. It costs a second and it has never lied to me.

## What it cost

I sat through a whole standup watching a spinner. That was the day I stopped trusting retries.
`;

export const CURRENT = `## The lid is a chaos monkey

I closed the laptop at six and the build died with it. Nobody told the runtime that a lid is a normal thing to close.

My first fix was a shell alias that kept the machine awake, and it cooked the battery inside a month.

The runtimes I have read do something much cheaper. They retry the call and carry on as if nothing had happened.

Every morning the daemon compares its list of jobs against the process table before it touches anything else, which takes about a second.

## What it cost

I sat through a whole standup watching a spinner. That was the day I stopped trusting retries.
`;
