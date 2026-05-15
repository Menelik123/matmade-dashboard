const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const JSONBIN_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN = process.env.JSONBIN_BIN_ID;
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`;

async function readData() {
  const res = await fetch(`${JSONBIN_URL}/latest`, {
    headers: { 'X-Master-Key': JSONBIN_KEY }
  });
  const json = await res.json();
  return json.record;
}

async function writeData(data) {
  await fetch(JSONBIN_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Master-Key': JSONBIN_KEY
    },
    body: JSON.stringify(data)
  });
}

app.get('/api/data', async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/start-campaign', async (req, res) => {
  try {
    const data = await readData();
    if (!data.campaignStartDate) {
      data.campaignStartDate = new Date().toISOString();
      await writeData(data);
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/scorecard-toggle', async (req, res) => {
  const { weekIndex, day, field } = req.body;
  try {
    const data = await readData();
    if (data.weeklyScorecard[weekIndex] && data.weeklyScorecard[weekIndex].days[day]) {
      data.weeklyScorecard[weekIndex].days[day][field] = !data.weeklyScorecard[weekIndex].days[day][field];
      await writeData(data);
      res.json({ success: true, value: data.weeklyScorecard[weekIndex].days[day][field] });
    } else {
      res.status(400).json({ success: false, error: 'Invalid week/day/field' });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/scorecard-add-week', async (req, res) => {
  const { weekLabel } = req.body;
  try {
    const data = await readData();
    data.weeklyScorecard.push({
      week: weekLabel,
      days: {
        Monday:    { dmsHit: false, postUp: false, dashUpdated: false },
        Tuesday:   { dmsHit: false, postUp: false, dashUpdated: false },
        Wednesday: { dmsHit: false, postUp: false, dashUpdated: false },
        Thursday:  { dmsHit: false, postUp: false, dashUpdated: false },
        Friday:    { dmsHit: false, postUp: false, dashUpdated: false }
      }
    });
    await writeData(data);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/update', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ success: false, error: 'No prompt provided' });
  }

  try {
    const currentData = await readData();

    const systemPrompt = `You are a data assistant for MatMade, the world's largest BJJ gym directory. You manage a growth campaign dashboard tracking gym outreach across all 50 US states.

Current dashboard data:
${JSON.stringify(currentData, null, 2)}

When given a natural language update, return ONLY a valid JSON object with the exact fields to update. Use this schema:

{
  "scoreboardUpdates": {
    "claimed": number,
    "paying": number,
    "statesActivated": number,
    "daysIntoCampaign": number,
    "mrr": number,
    "storiesCollected": number,
    "instagramPosts": number
  },
  "milestoneUpdates": [
    { "id": number, "completed": boolean }
  ],
  "gymAdd": [
    {
      "name": "string",
      "state": "string",
      "city": "string",
      "stage": "Not Contacted | Messaged | Responded | Claimed | Upsold | Closed",
      "tier": "None | Premium ($29) | Pro ($79) | City Feature ($149) | State Feature ($399)",
      "storyCollected": false,
      "instagramPosted": false,
      "lastContacted": "YYYY-MM-DD",
      "contact": "string",
      "notes": "string"
    }
  ],
  "gymUpdate": [
    { "id": number, "fields": { "stage": "string", "tier": "string", "storyCollected": boolean, "instagramPosted": boolean, "lastContacted": "YYYY-MM-DD", "notes": "string" } }
  ],
  "storyAdd": [
    {
      "gymName": "string",
      "studentName": "string",
      "status": "Intro Made | Interview Scheduled | Collected | Drafted | Posted",
      "scheduledDate": "YYYY-MM-DD or empty string",
      "instagramPosted": false,
      "profilePosted": false,
      "notes": "string"
    }
  ],
  "storyUpdate": [
    { "id": number, "fields": { "status": "string", "scheduledDate": "string", "instagramPosted": boolean, "profilePosted": boolean, "notes": "string" } }
  ],
  "contentAdd": [
    {
      "week": "string",
      "day": "string",
      "type": "State Locked In | Gym Spotlight | Transformation Story | Your Gym on the List | Weekly Progress",
      "source": "string",
      "status": "Not Started | In Progress | Scheduled | Posted",
      "notes": "string"
    }
  ],
  "contentUpdate": [
    { "id": number, "fields": { "status": "string", "source": "string", "notes": "string" } }
  ],
  "message": "Brief friendly confirmation of what was updated"
}

Only include keys that need to be changed. Omit keys for things not being updated.
If a milestone should logically complete based on the update, include it in milestoneUpdates.
When adding a gym, set lastContacted to today's date in YYYY-MM-DD format.
Return ONLY valid JSON. No text outside the JSON object.`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    });

    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Could not parse response');

    const updates = JSON.parse(jsonMatch[0]);
    const data = await readData();

    if (updates.scoreboardUpdates) Object.assign(data.scoreboard, updates.scoreboardUpdates);

    if (updates.milestoneUpdates?.length) {
      updates.milestoneUpdates.forEach(u => {
        const m = data.milestones.find(m => m.id === u.id);
        if (m) m.completed = u.completed;
      });
    }

    if (updates.gymAdd?.length) {
      updates.gymAdd.forEach(gym => {
        const newId = data.gyms.length > 0 ? Math.max(...data.gyms.map(g => g.id)) + 1 : 1;
        data.gyms.push({ id: newId, lastContacted: new Date().toISOString().split('T')[0], ...gym });
      });
    }

    if (updates.gymUpdate?.length) {
      updates.gymUpdate.forEach(u => {
        const gym = data.gyms.find(g => g.id === u.id);
        if (gym) Object.assign(gym, u.fields);
      });
    }

    if (updates.storyAdd?.length) {
      if (!data.stories) data.stories = [];
      updates.storyAdd.forEach(story => {
        const newId = data.stories.length > 0 ? Math.max(...data.stories.map(s => s.id)) + 1 : 1;
        data.stories.push({ id: newId, ...story });
      });
    }

    if (updates.storyUpdate?.length) {
      updates.storyUpdate.forEach(u => {
        const story = data.stories?.find(s => s.id === u.id);
        if (story) Object.assign(story, u.fields);
      });
    }

    if (updates.contentAdd?.length) {
      updates.contentAdd.forEach(post => {
        const newId = data.content.length > 0 ? Math.max(...data.content.map(c => c.id)) + 1 : 1;
        data.content.push({ id: newId, ...post });
      });
    }

    if (updates.contentUpdate?.length) {
      updates.contentUpdate.forEach(u => {
        const post = data.content.find(c => c.id === u.id);
        if (post) Object.assign(post, u.fields);
      });
    }

    await writeData(data);
    res.json({ success: true, data, message: updates.message || 'Dashboard updated.' });
  } catch (err) {
    console.error('Update error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n MatMade Dashboard running on port ${PORT}\n`);
});
