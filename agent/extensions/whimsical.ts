import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const messages = [
	"Negotiating with the gambling gods...",
	"Asking the roulette wheel nicely...",
	"Convincing the odds to cooperate...",
	"Looking for a legally distinct crystal ball...",
	"Consulting our certified luck engineer...",
	"Teaching statistics to believe in miracles...",
	"Trying to predict the unpredictable...",
	"Checking if luck is currently online...",
	"Reading tea leaves and match histories...",
	"Searching for free money (unsuccessfully)...",
	"Calculating emotional damage potential...",
	"Bribing randomness with compliments...",
	"Investigating suspiciously good odds...",
	"Counting chickens before they hatch...",
	"Pretending this is all skill...",
	"Converting hope into probability...",
	"Double-checking the universe's script...",
	"Waiting for the comeback arc...",
	"Looking for the main character...",
	"Simulating 14 million betting outcomes...",
	"Exploring timelines where this parlay hits...",
	"Consulting the ancient bookmakers...",
	"Examining vibes and momentum...",
	"Asking the coin to land correctly...",
	"Determining whether we're cooking...",
	"Verifying that we're so back...",
	"Fact-checking gut feelings...",
	"Searching for hidden plot armor...",
	"Calculating maximum sweat levels...",
	"Monitoring heart rate during live bets...",
	"Translating sports chaos into numbers...",
	"Measuring confidence in completely made-up units...",
	"Checking if the underdog got the memo...",
	"Trying not to jinx it...",
	"Assessing clown-to-genius ratio...",
	"Generating premium copium...",
	"Reviewing expert opinions we'll ignore anyway...",
	"Detecting signs of a trap bet...",
	"Estimating couch-coach confidence levels...",
	"Determining whether this is free money or a lesson...",
	"Analyzing suspiciously confident friends...",
	"Inspecting the moon phase for betting relevance...",
	"Checking Mercury's impact on parlays...",
	"Asking AI if it believes in destiny...",
	"Looking for statistical plot twists...",
	"Calculating how bad this beat could hurt...",
	"Preparing an 'it was obvious' explanation...",
	"Searching for hidden value and inner peace...",
	"Evaluating whether luck owes us one...",
	"Trying to stay humble before kickoff...",
	"Monitoring the emotional hedge fund...",
	"Converting delusion into confidence...",
	"Running advanced hopium analytics...",
	"Estimating celebration probability...",
	"Checking if today's the day...",
	"Searching for tomorrow's bragging rights...",
	"Detecting certified banger opportunities...",
	"Reviewing the script leak...",
	"Making sure the referee isn't the protagonist...",
	"Calculating the probability of absolute cinema...",
	"Following the money...",
	"Following the vibes...",
	"Comparing money with vibes...",
	"Finding out which one wins...",
	"Bribing the dealer...",
	"Asking the little tiger to release the card...",
];

function pickRandom(): string {
	return (
		messages[Math.floor(Math.random() * messages.length)] ??
		"Checking if luck is currently online..."
	);
}

export default function (pi: ExtensionAPI) {
	pi.on("turn_start", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(pickRandom());
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setWorkingMessage(); // Reset for next time
	});
}
