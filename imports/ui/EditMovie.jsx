import React, { Component } from "react";
import ReactDOM from "react-dom";
import { Meteor } from "meteor/meteor";
import { HTTP } from "meteor/http";
import { Navigate, useParams } from "react-router-dom";

function withRouter(Component) {
  function withComponent(props) {
    let params = useParams();
    return <Component {...props} params={params} />;
  }
  return withComponent;
}

class EditMovie extends Component {
  componentDidMount() {
    this.getMovie(this.props.params.idMovie);
  }

  constructor(props) {
    super(props);
    this.state = {
      movies: [],
      disableForm: true,
      idMovie: "",
      saveSuccess: false,
    };
    this.saveMovie = this.saveMovie.bind(this);
    this.getMovie = this.getMovie.bind(this);
    this.change_esTitle = this.change_esTitle.bind(this);
    this.change_esDirector = this.change_esDirector.bind(this);
    this.change_esDescription = this.change_esDescription.bind(this);
    this.change_usTitle = this.change_usTitle.bind(this);
    this.change_usDirector = this.change_usDirector.bind(this);
    this.change_usDescription = this.change_usDescription.bind(this);
    this.change_brTitle = this.change_brTitle.bind(this);
    this.change_brDirector = this.change_brDirector.bind(this);
    this.change_brDescription = this.change_brDescription.bind(this);
  }

  getMovie(id) {
    HTTP.call(
      "GET",
      `https://claychallengeback-production.up.railway.app/api/movie?id=${id}`,
      (error, result) => {
        if (!error) {
          this.setState({
            disableForm: false,
            idMovie: id,
            es_filim_title: result.data.ReadOfDataBsse[0]["es-ES"].filim_title,
            es_filim_director:
              result.data.ReadOfDataBsse[0]["es-ES"].filim_director,
            es_filim_description:
              result.data.ReadOfDataBsse[0]["es-ES"].filim_description,

            us_filim_title: result.data.ReadOfDataBsse[0]["en-US"].filim_title,
            us_filim_director:
              result.data.ReadOfDataBsse[0]["en-US"].filim_director,
            us_filim_description:
              result.data.ReadOfDataBsse[0]["en-US"].filim_description,

            br_filim_title: result.data.ReadOfDataBsse[0]["pt-BR"].filim_title,
            br_filim_director:
              result.data.ReadOfDataBsse[0]["pt-BR"].filim_director,
            br_filim_description:
              result.data.ReadOfDataBsse[0]["pt-BR"].filim_description,
          });
        }
      }
    );
  }

  saveMovie(event) {
    event.preventDefault();
    var formMovie = event.target;
    var movie = {
      _id: this.state.idMovie,
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

    console.log(" movie:", movie);
    HTTP.call(
      "PUT",
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

  showForm() {
    return (
      <form className="col s12" onSubmit={this.saveMovie}>
        <h5> Español [es-ES]: </h5>
        <div className="row">
          <div className="input-field col s6">
            <input
              id="es_filim_title"
              type="text"
              name="es_filim_title"
              value={this.state.es_filim_title}
              onChange={this.change_esTitle}
            />
            <label htmlFor="es_filim_title">Filim title</label>
          </div>
          <div className="input-field col s6">
            <input
              id="es_filim_director"
              type="text"
              name="es_filim_director"
              value={this.state.es_filim_director}
              onChange={this.change_esDirector}
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
              value={this.state.es_filim_description}
              onChange={this.change_esDescription}
            />
            <label htmlFor="es_filim_description">Filim description</label>
          </div>
        </div>

        <h5> English [en-US]: </h5>
        <div className="row">
          <div className="input-field col s6">
            <input
              id="us_filim_title"
              type="text"
              name="us_filim_title"
              value={this.state.us_filim_title}
              onChange={this.change_usTitle}
            />
            <label htmlFor="us_filim_title">Filim title</label>
          </div>
          <div className="input-field col s6">
            <input
              id="us_filim_director"
              type="text"
              name="us_filim_director"
              value={this.state.us_filim_director}
              onChange={this.change_usDirector}
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
              value={this.state.us_filim_description}
              onChange={this.change_usDescription}
            />
            <label htmlFor="us_filim_description">Filim description</label>
          </div>
        </div>

        <h5> Português [pt-BR]: </h5>
        <div className="row">
          <div className="input-field col s6">
            <input
              id="br_filim_title"
              type="text"
              name="br_filim_title"
              value={this.state.br_filim_title}
              onChange={this.change_brTitle}
            />
            <label htmlFor="br_filim_title">Filim title</label>
          </div>
          <div className="input-field col s6">
            <input
              id="br_filim_director"
              type="text"
              name="br_filim_director"
              value={this.state.br_filim_director}
              onChange={this.change_brDirector}
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
              value={this.state.br_filim_description}
              onChange={this.change_brDescription}
            />
            <label htmlFor="br_filim_description">Filim description</label>
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
    );
  }

  render() {
    return (
      <div>
        <div className="container">
          {!this.state.disableForm && this.showForm()}
        </div>
        {this.state.saveSuccess && <Navigate to="/" />}
      </div>
    );
  }

  // EVENT CHANGES :(
  change_esTitle(event) {
    this.setState({
      es_filim_title: event.target.value,
    });
  }

  change_esDirector(event) {
    this.setState({
      es_filim_director: event.target.value,
    });
  }

  change_esDescription(event) {
    this.setState({
      es_filim_description: event.target.value,
    });
  }

  change_usTitle(event) {
    this.setState({
      us_filim_title: event.target.value,
    });
  }

  change_usDirector(event) {
    this.setState({
      us_filim_director: event.target.value,
    });
  }

  change_usDescription(event) {
    this.setState({
      us_filim_description: event.target.value,
    });
  }

  change_brTitle(event) {
    this.setState({
      br_filim_title: event.target.value,
    });
  }

  change_brDirector(event) {
    this.setState({
      br_filim_director: event.target.value,
    });
  }

  change_brDescription(event) {
    this.setState({
      br_filim_description: event.target.value,
    });
  }
}
// export default EditMovie;
export default withRouter(EditMovie);
