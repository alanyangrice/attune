# Personalized Calming Music Agent — Technical Implementation

> **Platform note:** The current product direction in `design.md` is an Electron/Node app. This
> document preserves earlier mobile implementation exploration; the active Node integration lives
> in `electron/vitals/`, and the native Windows C++ camera test lives in `cpp/windows/`. Both
> follow the installed `.agents/skills/using-smartspectra` skill and current Presage docs.

## 1. Overview

The goal of the app is to determine **which music helps calm a particular user**, rather than assuming that a song is universally calming.

The app uses:

* **SmartSpectra** to measure physiological signals through the phone camera.
* **Spotify Web API** to search for and control music.
* A **Calmness Engine** to compare the user's physiological state before and after listening.
* A **Recommendation Engine / Agent** to select songs based on the user's previous responses.
* A local database to remember which songs have helped the user in the past.

The core feedback loop is:

```text
User
  ↓
SmartSpectra
  ↓
Baseline physiological measurement
  ↓
Recommendation Engine
  ↓
Spotify
  ↓
Play song
  ↓
SmartSpectra
  ↓
Post-song measurement
  ↓
Calmness Engine
  ↓
Did the user's state improve?
  ↓
Update user's song profile
  ↓
Better recommendation next time
```

---

# 2. Important Design Principle

The agent should **not** try to classify songs as simply:

```text
Calming
Not calming
```

Instead, it should estimate:

```text
How likely is this song to help THIS user right now?
```

For example:

```text
User A
Song: Ambient Piano
Response: +0.72

User B
Song: Ambient Piano
Response: -0.10
```

The same song can affect different people differently.

Therefore, the system should learn from the user's actual response.

---

# 3. SmartSpectra Integration

SmartSpectra provides physiological measurements such as:

* Heart rate
* Breathing rate
* HRV RMSSD
* Other available physiological signals

The application should wrap SmartSpectra in its own class so that the rest of the application does not depend directly on the SDK.

```kotlin
class SmartSpectraManager {

    private val sdk = SmartSpectraSdk.shared

    suspend fun start() {
        sdk.start()
    }

    suspend fun stop() {
        sdk.stop()
    }

    fun metrics() = sdk.metricsFlow
}
```

The manager converts SmartSpectra measurements into the application's own data model.

```kotlin
data class VitalsSample(
    val timestamp: Long,
    val heartRate: Double?,
    val breathingRate: Double?,
    val hrvRmssd: Double?
)
```

This makes it possible to change the measurement system later without changing the rest of the application.

---

# 4. Measurement Sessions

The app should collect measurements over a period of time rather than using one individual reading.

```kotlin
data class MeasurementSession(
    val startTime: Long,
    val endTime: Long,
    val samples: List<VitalsSample>
)
```

A session could look like:

```text
00:00 ───────────────── 01:00
       Collect measurements

HR:
82 84 83 81 82 80 ...

Breathing:
17 18 17 16 16 ...

HRV:
31 32 33 35 34 ...
```

The application then calculates a summary:

```kotlin
data class VitalsSummary(
    val averageHeartRate: Double?,
    val averageBreathingRate: Double?,
    val averageHrvRmssd: Double?,
    val durationSeconds: Long
)
```

---

# 5. Establishing a Baseline

Before playing music, the app measures the user's current state.

For example:

```text
Baseline

Heart Rate:       88
Breathing Rate:   19
HRV:              32
```

This is important because absolute values aren't enough.

Instead of asking:

> "Is an HR of 88 stressed?"

the application asks:

> "How did this user's measurements change compared with their own baseline?"

This makes the system more personalized.

---

# 6. Finding Candidate Songs

Spotify's current Web API should be used to find candidate tracks.

The app can search for categories such as:

```text
calm
relaxing
peaceful
ambient
piano
acoustic
meditation
sleep
lofi
```

The application should create a pool of candidate songs.

For example:

```text
Spotify Search

        ↓

Candidate Songs

Song A
Song B
Song C
Song D
Song E
```

The system then chooses among those candidates.

The application should **not depend on Spotify's old Audio Features or Recommendations APIs**, because those features are no longer available to new Web API use cases.

---

# 7. Song Data Structure

The application only needs to store basic Spotify information about each song.

```kotlin
data class SpotifyTrack(
    val id: String,
    val uri: String,
    val name: String,
    val artist: String,
    val album: String
)
```

The application can also store the user's historical response to a song.

```kotlin
data class SongResponse(
    val trackId: String,
    val beforeScore: Double,
    val afterScore: Double,
    val calmingEffect: Double,
    val timestamp: Long
)
```

---

# 8. The Calmness Engine

The Calmness Engine determines whether the user's physiological state moved in a direction associated with relaxation.

It compares:

```text
Before Song
       ↓
    Song Plays
       ↓
After Song
```

For example:

```text
BEFORE

HR:        88
Breathing: 19
HRV:       32


AFTER

HR:        81
Breathing: 15
HRV:       39
```

The system could produce:

```text
Calming Effect: +0.72
```

Another song might produce:

```text
BEFORE

HR:        81
Breathing: 15
HRV:       39


AFTER

HR:        89
Breathing: 18
HRV:       31
```

Result:

```text
Calming Effect: -0.64
```

The exact formula should be treated as a **wellness heuristic**, not a medically validated stress detector. The app should also account for measurement quality and missing/invalid samples.

A basic model could be:

```kotlin
data class CalmnessScore(
    val score: Double
)
```

with the score normalized to:

```text
-1.0 = response moved away from the target relaxation pattern
 0.0 = little/no change
+1.0 = response moved toward the target relaxation pattern
```

---

# 9. Personal Song Profiles

After every listening session, the app updates the user's history.

```kotlin
data class PersonalSongProfile(
    val trackId: String,
    val timesPlayed: Int,
    val averageCalmingEffect: Double
)
```

For example:

```text
Song                         Plays    Average Effect

Ambient Piano                 8          +0.71
Rain Sounds                   5          +0.62
Lo-fi Beats                   6          +0.31
Heavy Rock                    4          -0.42
Fast EDM                      3          -0.67
```

Now the application has learned something specific about the user.

---

# 10. Recommendation Engine

The Recommendation Engine combines several pieces of information:

```text
Spotify candidate songs
          +
User's previous responses
          +
Current physiological state
          +
Exploration
          ↓
      Best candidate
```

For example, suppose the user currently appears more activated than their normal baseline.

The recommendation engine might see:

```text
Ambient Piano
Previous effect: +0.71

Acoustic
Previous effect: +0.42

Lo-fi
Previous effect: +0.31

EDM
Previous effect: -0.67
```

It would prioritize ambient piano.

However, it shouldn't **always** play the exact same song.

It should occasionally explore new songs.

A simple scoring model could be:

```text
Recommendation Score =
    Personal Effect
    + Candidate Relevance
    + Exploration Bonus
```

This creates a balance between:

```text
EXPLOIT
Play music that already works

EXPLORE
Try something new
```

---

# 11. The Agent

The "agent" sits above the recommendation system.

Its job is not to directly process raw physiological data.

Instead:

```text
SmartSpectra
      ↓
Measurement Manager
      ↓
Calmness Engine
      ↓
Structured state
      ↓
Agent / Recommendation Engine
      ↓
Spotify
```

The agent might receive:

```json
{
    "current_state": "elevated",
    "baseline_difference": 0.62,
    "top_music_categories": [
        "ambient",
        "piano",
        "acoustic"
    ],
    "previous_successes": [
        {
            "track_id": "abc123",
            "effect": 0.71
        }
    ]
}
```

It can then reason:

> The user's current state is more activated than baseline. Ambient and piano tracks have historically produced positive responses for this user. Select a candidate from these categories while occasionally exploring new music.

The important distinction is:

**The agent makes decisions using structured information; it does not need to be trained on Spotify's music/content.**

---

# 12. Complete Session Flow

The main controller can coordinate the entire experience.

```kotlin
class CalmSessionController(
    private val measurementManager: MeasurementManager,
    private val spotifyManager: SpotifyManager,
    private val calmnessEngine: CalmnessEngine,
    private val recommendationEngine: RecommendationEngine
) {

    suspend fun startSession() {

        val baseline = measurementManager.measure()

        val song = recommendationEngine.chooseSong()

        spotifyManager.playTrack(song.uri)

        waitForSong()

        val after = measurementManager.measure()

        val result = calmnessEngine.calculate(
            baseline,
            after
        )

        recommendationEngine.recordResult(
            song,
            result
        )
    }
}
```

The real implementation would need to handle playback state, interruptions, measurement quality, errors, and session cancellation.

---

# 13. Spotify API Flow

Authentication should use **OAuth Authorization Code with PKCE** for the Android application.

The basic flow is:

```text
Android App
    ↓
Spotify Authorization
    ↓
User logs in
    ↓
Authorization Code
    ↓
App exchanges code for access token
    ↓
Spotify Web API
```

The application can then use the user's token for operations such as:

```text
Search tracks
        ↓
Get current playback
        ↓
Play track
        ↓
Add track to queue
        ↓
Monitor playback
```

The app should never put a Spotify client secret directly into the Android application.

---

# 14. Data Storage

The application should store the user's own response history locally, for example using Room.

Possible tables:

```text
Song
----------------
spotifyId
name
artist
uri


SongResponse
----------------
id
spotifyId
beforeScore
afterScore
calmingEffect
timestamp


UserProfile
----------------
averageBaseline
preferredCategories
```

The most important information is the relationship:

```text
User
  ↓
Song
  ↓
Physiological Response
  ↓
Calming Effect
```

Over time this becomes the application's personalized music model.

---

# 15. Example of Learning

Initially the system knows nothing about the user.

```text
User starts session

        ↓

Search calm music

        ↓

Choose Ambient Piano

        ↓

Measure response

        ↓

Effect = +0.72

        ↓

Save result
```

Later:

```text
Ambient Piano
Average Effect = +0.72
```

The system tries another song:

```text
Acoustic Guitar
Effect = +0.48
```

After enough sessions:

```text
Ambient Piano       +0.72
Nature Sounds       +0.68
Acoustic Guitar     +0.48
Lo-fi               +0.22
EDM                 -0.51
```

The recommendation engine now has evidence about what tends to work for this particular user.

---

# 16. Recommended Architecture

```text
                 ┌─────────────────┐
                 │   MainActivity   │
                 └────────┬────────┘
                          │
                          ▼
                ┌────────────────────┐
                │ CalmSessionManager │
                └───────┬────────────┘
                        │
          ┌─────────────┼─────────────┐
          ▼             ▼             ▼
 ┌────────────────┐ ┌───────────┐ ┌───────────────┐
 │ SmartSpectra   │ │  Spotify  │ │ Personal Data │
 │ Manager        │ │  Manager  │ │ / Room        │
 └───────┬────────┘ └─────┬─────┘ └───────────────┘
         │                │
         ▼                │
 ┌────────────────┐       │
 │ Measurement    │       │
 │ Manager        │       │
 └───────┬────────┘       │
         ▼                │
 ┌────────────────┐       │
 │ Calmness       │       │
 │ Engine         │       │
 └───────┬────────┘       │
         │                │
         ▼                ▼
       ┌──────────────────────┐
       │ Recommendation       │
       │ Engine / Agent       │
       └──────────┬───────────┘
                  │
                  ▼
             Spotify Song
                  │
                  ▼
                User
                  │
                  └───────→ SmartSpectra
```

---

# 17. MVP

The first version does not need a sophisticated AI model.

The MVP should implement:

### Step 1

Measure the user's baseline with SmartSpectra.

### Step 2

Search Spotify for a small number of calming categories.

### Step 3

Choose a candidate song.

### Step 4

Play the song.

### Step 5

Measure the user again.

### Step 6

Calculate a response score.

### Step 7

Store:

```text
Song → User's response
```

### Step 8

Use those results to choose better songs next time.

After this works, more sophisticated personalization can be added.

---

# 18. Key Idea

The most important part of the system is the feedback loop:

```text
Don't ask:

"Is this song calming?"

Ask:

"Did this song make THIS USER calmer?"
```

That turns the application from a generic "calming music recommender" into a **personalized adaptive system**.

The app continuously learns:

```text
Physiological state
        ↓
Music choice
        ↓
User response
        ↓
Measure response
        ↓
Update model
        ↓
Better music choice
```

This is the core mechanism that allows the agent to become more useful over time.
