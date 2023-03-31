import React, { Component } from "react";
import ReactDOM from "react-dom";
import { Meteor } from "meteor/meteor";
import { HTTP } from "meteor/http";
import { Navigate } from "react-router-dom";

export default class AddMovie extends Component {
  constructor(props) {
    super(props);
    this.state = {
      saveSuccess: false,
    };
    this.saveMovie = this.saveMovie.bind(this);
  }

  saveMovie(event) {
    event.preventDefault();
    var formMovie = event.target;
    var movie = {
      "es-ES": {
        filim_title: formMovie.es_filim_title.value,
        filim_description: formMovie.es_filim_description.value,
        filim_director: formMovie.es_filim_director.value,
      },
      "en-US": {
        filim_title: formMovie.us_filim_title.value,
        filim_description: formMovie.us_filim_description.value,
        filim_director: formMovie.us_filim_director.value,
      },
      "pt-BR": {
        filim_title: formMovie.br_filim_title.value,
        filim_description: formMovie.br_filim_description.value,
        filim_director: formMovie.br_filim_director.value,
      },
    };
    HTTP.call(
      "POST",
      "https://claychallengeback-production.up.railway.app/api/movie",
      { data: movie },
      (error, result) => {
        if (!error) {
          this.setState({
            saveSuccess: true,
          });
        }
      }
    );
  }

  render() {
    return (
      <div>
        <div className="container">
          <div className="row">
            <form className="col s12" onSubmit={this.saveMovie}>
              <h5> Español [es-ES]: </h5>
              <div className="row">
                <div className="input-field col s6">
                  <input
                    id="es_filim_title"
                    type="text"
                    name="es_filim_title"
                  />
                  <label htmlFor="es_filim_title">Filim title</label>
                </div>
                <div className="input-field col s6">
                  <input
                    id="es_filim_director"
                    type="text"
                    name="es_filim_director"
                  />
                  <label htmlFor="es_filim_director">Filim director</label>
                </div>
              </div>

              <div className="row">
                <div className="input-field col s12">
                  <input
                    id="es_filim_description"
                    type="text"
                    className="validate"
                    name="es_filim_description"
                  />
                  <label htmlFor="es_filim_description">
                    Filim description
                  </label>
                </div>
              </div>

              <h5> English [en-US]: </h5>
              <div className="row">
                <div className="input-field col s6">
                  <input
                    id="us_filim_title"
                    type="text"
                    name="us_filim_title"
                  />
                  <label htmlFor="us_filim_title">Filim title</label>
                </div>
                <div className="input-field col s6">
                  <input
                    id="us_filim_director"
                    type="text"
                    name="us_filim_director"
                  />
                  <label htmlFor="us_filim_director">Filim director</label>
                </div>
              </div>

              <div className="row">
                <div className="input-field col s12">
                  <input
                    id="us_filim_description"
                    type="text"
                    name="us_filim_description"
                  />
                  <label htmlFor="us_filim_description">
                    Filim description
                  </label>
                </div>
              </div>

              <h5> Português [pt-BR]: </h5>
              <div className="row">
                <div className="input-field col s6">
                  <input
                    id="br_filim_title"
                    type="text"
                    name="br_filim_title"
                  />
                  <label htmlFor="br_filim_title">Filim title</label>
                </div>
                <div className="input-field col s6">
                  <input
                    id="br_filim_director"
                    type="text"
                    name="br_filim_director"
                  />
                  <label htmlFor="br_filim_director">Filim director</label>
                </div>
              </div>

              <div className="row">
                <div className="input-field col s12">
                  <input
                    id="br_filim_description"
                    type="text"
                    name="br_filim_description"
                  />
                  <label htmlFor="br_filim_description">
                    Filim description
                  </label>
                </div>
              </div>

              <div className="right-align">
                <button
                  className="btn waves-effect waves-light"
                  type="submit"
                  name="action"
                >
                  Submit
                  <i className="material-icons right">send</i>
                </button>
              </div>
            </form>
          </div>
        </div>
        {this.state.saveSuccess && <Navigate to="/" />}
      </div>
    );
  }
}
