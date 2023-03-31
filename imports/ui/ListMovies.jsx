import React, { Component } from "react";
import ReactDOM from "react-dom";
import { Meteor } from "meteor/meteor";
import { HTTP } from "meteor/http";
import { Link } from "react-router-dom";
export default class ListMovies extends Component {
  constructor(props) {
    super(props);
    this.state = {
      movies: [],
      lengActual: "",
    };
    this.getMovies("pt-BR");
  }

  getMovies(lng) {
    HTTP.call(
      "GET",
      "https://claychallengeback-production.up.railway.app/api/movies",
      (error, result) => {
        if (!error) {
          const tempresp = [];
          result.data.ReadOfDataBsse.filter((obj) => {
            tempresp.push([obj[lng], { _id: obj._id }]);
          });
          this.setState({
            movies: tempresp,
            lengActual: lng,
          });
        }
      }
    );
  }

  deleteMovie(idFilm) {
    HTTP.call(
      "DELETE",
      `https://claychallengeback-production.up.railway.app/api/movie?id=${idFilm}`,
      (error, result) => {
        if (!error) {
          this.getMovies(this.state.lengActual);
        }
      }
    );
  }

  showMovies() {
    return this.state.movies.map((movie) => (
      <tr key={movie[1]._id}>
        <td> {movie[0].filim_title}</td>
        <td>{movie[0].filim_director}</td>
        <td> {movie[0].filim_description}</td>

        <td>
          <Link
            className="waves-effect waves-teal btn-flat"
            to={`/edit/${movie[1]._id}`}
          >
            {" "}
            edit{" "}
          </Link>

          <a
            className="waves-effect waves-teal btn-flat"
            onClick={() => this.deleteMovie(movie[1]._id)}
          >
            Del
          </a>
        </td>
      </tr>
    ));
  }

  render() {
    return (
      <div>
        <div className="container">
          <br />
          <a
            className="waves-effect waves-teal btn-flat"
            onClick={() => this.getMovies("en-US")}
          >
            Ingles
          </a>
          <a
            className="waves-effect waves-teal btn-flat"
            onClick={() => this.getMovies("es-ES")}
          >
            Español
          </a>
          <a
            className="waves-effect waves-teal btn-flat"
            onClick={() => this.getMovies("pt-BR")}
          >
            Portugués
          </a>
          <table>
            <thead>
              <tr>
                <th>Film Title</th>
                <th>Director Name</th>
                <th>Film Description</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>{this.showMovies("pt-BR")}</tbody>
          </table>
        </div>
      </div>
    );
  }
}
