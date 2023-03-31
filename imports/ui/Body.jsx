import React from "react";
import { Routes, Route } from "react-router-dom";
import AddMovie from "./AddMovie.jsx";
import ListMovies from "./ListMovies.jsx";
import EditMovie from "./EditMovie.jsx";

const Body = () => (
  <Routes>
    <Route exact path="/" element={<ListMovies />} />
    <Route path="/insert" exact element={<AddMovie />} />
    <Route path="/edit/:idMovie" exact element={<EditMovie />} />
  </Routes>
);

export default Body;
