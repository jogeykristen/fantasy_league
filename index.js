const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { MongoClient, ServerApiVersion } = require("mongodb");
require("dotenv").config();

const app = express();
const port = 3000;

app.use(bodyParser.json());

// Database Details
const DB_USER = process.env["DB_USER"];
const DB_PWD = process.env["DB_PWD"];
const DB_URL = process.env["DB_URL"];
const DB_NAME = "task-jeff";
const PLAYERS_COLLECTION = "players";
const TEAMS_COLLECTION = "teams";
const MATCH_COLLECTION = "match";

console.log("user = ", DB_USER, "password = ", DB_PWD, "url = ", DB_URL);

const uri = `mongodb+srv://${DB_USER}:${DB_PWD}@${DB_URL}/?retryWrites=true&w=majority`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let db;

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    db = client.db(DB_NAME);
    console.log("You successfully connected to MongoDB!");

    // Load initial data into MongoDB
    await loadInitialData();
  } finally {
  }
}

async function loadInitialData() {
  try {
    const playersData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "data", "players.json"))
    );
    const matchData = JSON.parse(
      fs.readFileSync(path.join(__dirname, "data", "match.json"))
    );

    await db.collection(PLAYERS_COLLECTION).deleteMany({});
    await db.collection(MATCH_COLLECTION).deleteMany({});
    await db.collection(PLAYERS_COLLECTION).insertMany(playersData);
    await db.collection(MATCH_COLLECTION).insertMany(matchData);

    console.log("Initial data loaded into MongoDB!");
  } catch (error) {
    console.error("Error loading initial data:", error);
  }
}

// Validate team entry
function validateTeamEntry(team) {
  const { players, captain, viceCaptain } = team;

  if (players.length !== 11) {
    return "A team must have exactly 11 players.";
  }

  if (new Set(players).size !== players.length) {
    return "Duplicate players are not allowed.";
  }

  if (!players.includes(captain)) {
    return "Captain must be one of the players in the team.";
  }

  if (!players.includes(viceCaptain)) {
    return "Vice-Captain must be one of the players in the team.";
  }

  const roleCounts = {
    WICKETKEEPER: 0,
    BATTER: 0,
    "ALL-ROUNDER": 0,
    BOWLER: 0,
  };

  const teams = new Set();
  const playerData = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "players.json"), "utf-8")
  );

  players.forEach((playerName) => {
    const player = playerData.find(
      (p) => p.Player.toUpperCase() === playerName.toUpperCase()
    );
    if (!player) {
      throw new Error(`Player ${playerName} not found.`);
    }

    const role = player.Role.toUpperCase(); // Capitalize role name
    roleCounts[role] += 1; // Use capitalized role as key

    teams.add(player.Team);
  });

  if (teams.size > 2) {
    return "Players must be from a maximum of two teams.";
  }
  console.log("tolecounts: ", roleCounts);
  if (roleCounts.WK < 1 || roleCounts.WK > 8) {
    return "Team must have between 1 and 8 wicketkeepers.";
  }

  if (roleCounts.BAT < 1 || roleCounts.BAT > 8) {
    return "Team must have between 1 and 8 batters.";
  }

  if (roleCounts.AR < 1 || roleCounts.AR > 8) {
    return "Team must have between 1 and 8 all-rounders.";
  }

  if (roleCounts.BWL < 1 || roleCounts.BWL > 8) {
    return "Team must have between 1 and 8 bowlers.";
  }

  return null;
}

// Calculate points
async function calculatePoints(matchData, team) {
  const points = {};

  matchData.forEach((ball) => {
    const {
      batter,
      bowler,
      non_striker,
      batsman_run,
      extras_run,
      isWicketDelivery,
      player_out,
      kind,
      fielders_involved,
    } = ball;

    if (!points[batter]) points[batter] = 0;
    if (!points[bowler]) points[bowler] = 0;

    // Batting points
    points[batter] += batsman_run;
    if (batsman_run === 4) points[batter] += 1;
    if (batsman_run === 6) points[batter] += 2;

    // Bowling points
    if (isWicketDelivery && kind !== "run out") {
      points[bowler] += 25;
      if (kind === "lbw" || kind === "bowled") points[bowler] += 8;
    }

    // Fielding points
    if (isWicketDelivery && fielders_involved) {
      const fielders = fielders_involved.split(", ");
      fielders.forEach((fielder) => {
        if (!points[fielder]) points[fielder] = 0;
        points[fielder] += 8;
      });
    }
  });

  let totalPoints = 0;

  team.players.forEach((player) => {
    let playerPoints = points[player] || 0;
    if (player === team.captain) playerPoints *= 2;
    if (player === team.viceCaptain) playerPoints *= 1.5;
    totalPoints += playerPoints;
  });

  return totalPoints;
}

// Endpoints

// Add Team Entry
app.post("/add-team", async (req, res) => {
  const { name, players, captain, viceCaptain } = req.body;

  const team = { name, players, captain, viceCaptain };

  // const playerData = JSON.parse(
  //   fs.readFileSync(path.join(__dirname, "data", "players.json"), "utf-8")
  // );

  const validationError = validateTeamEntry(team);
  if (validationError) {
    return res.status(400).json({ status: 0, message: validationError });
  }

  try {
    await db.collection(TEAMS_COLLECTION).insertOne(team);
    res.send({ status: 1, message: "Team added successfully!" });
  } catch (error) {
    res.status(500).send({ status: 0, message: "Error adding team" });
  }
});

// Process Match Result
app.post("/process-result", async (req, res) => {
  try {
    const matchData = await db.collection(MATCH_COLLECTION).find().toArray();
    const teams = await db.collection(TEAMS_COLLECTION).find().toArray();

    for (let team of teams) {
      const totalPoints = await calculatePoints(matchData, team);
      await db
        .collection(TEAMS_COLLECTION)
        .updateOne({ _id: team._id }, { $set: { totalPoints } });
    }

    res.send({ status: 1, message: "Match results processed successfully!" });
  } catch (error) {
    res
      .status(500)
      .send({ status: 0, message: "Error processing match results" });
  }
});

// View Team Results
app.get("/team-result", async (req, res) => {
  try {
    const teams = await db.collection(TEAMS_COLLECTION).find().toArray();
    const maxPoints = Math.max(...teams.map((team) => team.totalPoints));

    const winners = teams.filter((team) => team.totalPoints === maxPoints);

    res.send({ status: 1, winners });
  } catch (error) {
    res
      .status(500)
      .send({ status: 0, message: "Error retrieving team results" });
  }
});

app.listen(port, () => {
  console.log(`App listening on port ${port}`);
});

run().catch(console.dir);
