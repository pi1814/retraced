import "source-map-support/register";
import * as _ from "lodash";
import * as bugsnag from "bugsnag";
import * as monkit from "monkit";

import { errToLog, jobDesc, stopwatchClick } from "./common";
import nsq from "./persistence/nsq";
import normalizeEvent from "./workers/normalizeEvent";
import saveEventToElasticsearch from "./workers/saveEventToElasticsearch";
import saveUserReportingEvent from "./workers/saveUserReportingEvent";
import saveActiveActor from "./workers/saveActiveActor";
import saveActiveGroup from "./workers/saveActiveGroup";
import analyzeDay from "./workers/analyzeDay";
import scheduleDailyReportsDue from "./workers/scheduleDailyReportsDue";
import streamEvent from "./workers/streamEvent";
import prunePipeSessions from "./workers/prunePipeSessions";
import pruneViewerDescriptors from "./workers/pruneViewerDescriptors";
import updateGeoData from "./workers/updateGeoData";
import sendEmail from "./workers/sendEmail";
import ingestFromBacklog from "./workers/ingestFromBacklog";
import ingestFromQueue from "./workers/ingestFromQueue";
import indexEvent from "./workers/indexEvent";
import { worker as normalizeRepair } from "./workers/NormalizeRepairer";
import {
  repair as elasticsearchAliasVerify,
  worker as elasticsearchIndexRotator,
} from "./workers/ElasticsearchIndexRotator";
import * as metrics from "./metrics";
import { logger } from "./logger";
import { startHealthz, updateLastNSQ } from "./healthz";
import getPgPool from "../persistence/pg";

if (!process.env["BUGSNAG_TOKEN"]) {
  logger.error("BUGSNAG_TOKEN not set, error reports will not be sent to bugsnag");
} else {
  bugsnag.register(process.env["BUGSNAG_TOKEN"] || "", {
    releaseStage: process.env["STAGE"],
    notifyReleaseStages: ["production", "staging"],
  });
}

let PG_SEARCH = false;
if (process.env["PG_SEARCH"]) {
    logger.info("PG_SEARCH  set, using Postgres search");
    PG_SEARCH = true;
} else {
    logger.info("PG_SEARCH not set, using ElasticSearch");
}
let NO_WARP_PIPE = false;
if (process.env["NO_WARP_PIPE"]) {
    NO_WARP_PIPE = true;
    logger.info("NO_WARP_PIPE set, disabling Warp Pipe jobs");
} else {
    logger.info("NO_WARP_PIPE not set - Warp Pipe jobs enabled");
}

const leftPad = (s, n) => n > s.length ? " ".repeat(n - s.length) + s : s;
const registry = monkit.getRegistry();

metrics.bootstrapFromEnv();
startHealthz();

const slowElapsedThreshold = 250.0; // ms

interface Consumer {
  topic: string;
  channel: string;
  worker: (Message) => void;
  maxAttempts: number;
  timeoutSeconds: number;
  maxInFlight: number;
}

const esConsumers: Consumer[] = [
  {
    topic: "normalized_events",
    channel: "save_to_elasticsearch",
    worker: saveEventToElasticsearch,
    maxAttempts: 3,
    timeoutSeconds: 30,
    maxInFlight: 5,
  },
  {
    topic: "eleven_minutes_to_midnight",
    channel: "rotate_elasticsearch_indices",
    worker: elasticsearchIndexRotator,
    maxAttempts: 1,
    timeoutSeconds: 300,
    maxInFlight: 1,
  },
  {
    topic: "every_minute",
    channel: "repair_elasticsearch_index_aliases",
    worker: elasticsearchAliasVerify,
    maxAttempts: 1,
    timeoutSeconds: 300,
    maxInFlight: 1,
  },
];

const pgSearchConsumers: Consumer[] = [
  {
      topic: "normalized_events",
      channel: "index_events",
      worker: indexEvent,
      maxAttempts: 3,
      timeoutSeconds: 20,
      maxInFlight: 10,
  },
];

const warpPipeConsumers: Consumer[] = [
  {
    topic: "nineteen_past_hour",
    channel: "prune_pipe_sessions",
    worker: prunePipeSessions,
    maxAttempts: 1,
    timeoutSeconds: 60,
    maxInFlight: 1,
  },
  {
    topic: "normalized_events",
    channel: "stream_event",
    worker: streamEvent,
    maxAttempts: 1,
    timeoutSeconds: 10,
    maxInFlight: 5,
  },
];

//
// If the worker does not throw any errors with the retry flag set, there is
// no point setting the maxAttempts above 1 here.
const nsqConsumers: Consumer[] = [
  ...(PG_SEARCH ? pgSearchConsumers : esConsumers),
  ...(NO_WARP_PIPE ? [] : warpPipeConsumers),
  {
    topic: "raw_events",
    channel: "normalize",
    worker: normalizeEvent,
    maxAttempts: 1,
    timeoutSeconds: 30,
    maxInFlight: 5,
  },
  {
    topic: "normalized_events",
    channel: "save_active_actor",
    worker: saveActiveActor,
    maxAttempts: 3,
    timeoutSeconds: 10,
    maxInFlight: 5,
  },
  {
    topic: "normalized_events",
    channel: "save_active_group",
    worker: saveActiveGroup,
    maxAttempts: 3,
    timeoutSeconds: 10,
    maxInFlight: 5,
  },
  {
    topic: "fifty_three_past_hour",
    channel: "schedule_daily_reports_due",
    worker: scheduleDailyReportsDue,
    maxAttempts: 1,
    timeoutSeconds: 60,
    maxInFlight: 1,
  },
  {
    topic: "every_ten_minutes",
    channel: "normalize_repair",
    worker: normalizeRepair,
    maxAttempts: 1,
    timeoutSeconds: 60,
    maxInFlight: 1,
  },
  {
      topic: "every_ten_minutes",
      channel: "prune_viewer_descriptors",
      worker: pruneViewerDescriptors,
      maxAttempts: 1,
      timeoutSeconds: 60,
      maxInFlight: 1,
  },
  {
    topic: "first_wed_of_month",
    channel: "update_geo_data",
    worker: updateGeoData,
    maxAttempts: 1,
    timeoutSeconds: 900,
    maxInFlight: 1,
  },
  {
    topic: "environment_day",
    channel: "analyze_day",
    worker: analyzeDay,
    maxAttempts: 1,
    timeoutSeconds: 10,
    maxInFlight: 5,
  },
  {
    topic: "user_reporting_task",
    channel: "save_user_reporting_event",
    worker: saveUserReportingEvent,
    maxAttempts: 1,
    timeoutSeconds: 10,
    maxInFlight: 5,
  },
  {
    topic: "every_second",
    channel: "clear_ingest_backlog",
    worker: ingestFromBacklog,
    maxAttempts: 1,
    timeoutSeconds: 10,
    maxInFlight: 1,
  },
  {
    topic: "unsaved_events",
    channel: "clear_ingest_queue",
    worker: ingestFromQueue,
    maxAttempts: 20,
    timeoutSeconds: 10,
    maxInFlight: 10,
  },
  {
    topic: "emails",
    channel: "send",
    worker: sendEmail,
    maxAttempts: 10,
    timeoutSeconds: 60,
    maxInFlight: 10,
  },
];

if (!PG_SEARCH) {
    elasticsearchAliasVerify();
}

for (const consumer of nsqConsumers) {
  const { topic, channel, worker, maxAttempts, timeoutSeconds, maxInFlight } = consumer;

  const receive = async (msg) => {
    const doAck = () => msg.finish();
    const requeue = () => msg.requeue(15000, true);
    const attempt = msg.attempt > 1 ? ` attempt ${msg.attempts} of ${maxAttempts}` : "";

    logger.debug(`-> ${leftPad(topic, 20)} ${leftPad(channel, 25)} ${attempt}...`);
    await monkit.instrument(
        `processor.${topic}__${channel}`,
        handle(topic, channel, worker, msg, doAck, requeue),
    );
  };

  nsq.consume(topic, channel, receive, {
    maxAttempts,
    maxInFlight,
    messageTimeoutMS: timeoutSeconds * 1000,
  });
}

const handle = (topic, channel, worker, job, doAck, requeue) => async () => {
  const startTime = process.hrtime();
  try {
    await worker(job);
    const elapsed = stopwatchClick(startTime);
    logger.debug(`✓  ${leftPad(topic, 20)} ${leftPad(channel, 25)}`);
    await doAck(job);
    if (elapsed >= slowElapsedThreshold) {
      logger.warn(`[${jobDesc(job)}] completed (slowly) in ${elapsed.toFixed(3)}ms`);
    }
    updateLastNSQ();

  } catch (err) {
    registry.meter("processor.waitForJobs.errors").mark();
    bugsnag.notify(err);
    const elapsed = stopwatchClick(startTime);
    let retry = false;
    if (_.has(err, "retry")) {
      retry = err.retry;
    }
    logger.error(`✘  ${leftPad(topic, 20)} ${leftPad(channel, 25)}`);
    logger.error(`[${jobDesc(job)}] failed (took ${elapsed.toFixed(3)}ms): ${errToLog(err)}`);
    if (retry === true) {
      logger.info(`[${jobDesc(job)}] this job will be retried later`);
      requeue();
    } else {
      await doAck(job);
      logger.error(`[${jobDesc(job)}] this job will NOT be retried`);
    }
  }

};

logger.info("retraced-processor");
process.on("SIGTERM", async () => {
  logger.info("Got SIGTERM. Graceful shutdown start", new Date().toISOString());
  logger.info("draining postgres pool");
  await getPgPool().end();
  logger.info("postgres pool drained");
  process.exit(137);
});
