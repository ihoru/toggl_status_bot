const { default: axios } = require("axios");

class TogglTrackAPI {
  static BASE_URL = "https://api.track.toggl.com/api/v9/";

  static async _request(token, path) {
    try {
      const response = await axios.get(TogglTrackAPI.BASE_URL + path, {
        auth: {
          username: token,
          password: "api_token",
        },
      });
      return response.data;
    } catch (error) {
      console.error("TogglTrackAPI error", error);
    }
  }

  static me = (token) => {
    return TogglTrackAPI._request(token, "me");
  }

  static currentTimer = (token) => {
    return TogglTrackAPI._request(token, "me/time_entries/current");
  }
}

module.exports = TogglTrackAPI;
