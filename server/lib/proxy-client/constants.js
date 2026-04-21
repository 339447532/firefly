/**
 * Constants - Channel attribute keys (mirrors Java Constants.java)
 */

// NEXT_CHANNEL: Paired channel (proxy <-> real server)
const NEXT_CHANNEL = 'nxt_channel';

// USER_ID: User identifier for this connection
const USER_ID = 'user_id';

// CLIENT_KEY: Client authentication key
const CLIENT_KEY = 'client_key';

// USER_CHANNEL_WRITEABLE: Tracks proxy channel writeability
const USER_CHANNEL_WRITEABLE = 'user_channel_writeable';

// CLIENT_CHANNEL_WRITEABLE: Tracks real server channel writeability
const CLIENT_CHANNEL_WRITEABLE = 'client_channel_writeable';

module.exports = {
  NEXT_CHANNEL,
  USER_ID,
  CLIENT_KEY,
  USER_CHANNEL_WRITEABLE,
  CLIENT_CHANNEL_WRITEABLE
};