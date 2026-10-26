//! Losowanie: rzadkość i karta ze skrzynki, wariant karty, wygrane w kasynie (karty o zadanej wartości).

use std::sync::Arc;

use rand::seq::SliceRandom;
use rand::Rng;

use crate::catalog::{Catalog, Crate, Person};
use crate::data::{combine_variant, g};

/// random.choices(population, weights)[0] - indeks albo None (suma wag <= 0)
pub fn choose_weighted(weights: &[f64]) -> Option<usize> {
    let total: f64 = weights.iter().sum();
    if total <= 0.0 || weights.is_empty() {
        return None;
    }
    let r = rand::thread_rng().gen::<f64>() * total;
    let mut acc = 0.0;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if r < acc {
            return Some(i);
        }
    }
    weights.iter().rposition(|w| *w > 0.0)
}

pub fn random() -> f64 {
    rand::thread_rng().gen()
}

/// Wariant karty poza skrzynką (kontrakt): wszystkie zwykłe warianty + extra (bez extra: tylko zwykłe warianty).
pub fn roll_variant(factor: f64, extra: &[String]) -> String {
    roll_from(factor, extra, false)
}

/// Wariant karty. listed_only: tylko warianty z listy (skrzynka - warianty do niej przypięte, catalog.crate_variants),
/// inaczej wszystkie zwykłe + lista (wyjątkowe dostępne tu).
/// Wariant-warstwa (flaga) z szansą "extraChance" dostaje jeszcze jeden wariant - z tymi samymi szansami co zwykle.
/// Warianty "always" (halloweenowe): w tej skrzynce każda karta dostaje jeden z nich (według "weight"), a zwykły
/// wariant losuje się normalnie - chyba że wylosowany ma "noCombo": wtedy karta ma tylko ten wariant.
fn roll_from(factor: f64, extra: &[String], listed_only: bool) -> String {
    let g = g();
    let always: Vec<&String> = extra.iter().filter(|v| g.variants[*v].always).collect();
    if !always.is_empty() {
        let weights: Vec<f64> = always.iter().map(|v| g.variants[*v].weight.unwrap_or(1.0)).collect();
        let layer = always[choose_weighted(&weights).unwrap_or(0)];
        if g.variants[layer].no_combo {
            return layer.clone();
        }
        let rest: Vec<String> = extra.iter().filter(|v| !g.variants[*v].layer).cloned().collect();
        return combine_variant(layer, &roll_from(factor, &rest, listed_only));
    }
    // najrzadsze najpierw
    let specials: Vec<&String> = g
        .variant_order
        .iter()
        .rev()
        .filter(|v| {
            let x = &g.variants[*v];
            *v != "normal" && !x.combo && (extra.contains(v) || (!listed_only && !x.exclusive))
        })
        .collect();
    let total: f64 = specials.iter().map(|v| g.variants[*v].chance).sum();
    let factor = if total != 0.0 { factor.min(0.9 / total) } else { factor };
    let mut rng = rand::thread_rng();
    let r: f64 = rng.gen();
    let mut acc = 0.0;
    for v in &specials {
        let x = &g.variants[*v];
        acc += x.chance * factor;
        if r < acc {
            if x.layer && rng.gen::<f64>() < x.extra_chance {
                let bases: Vec<&&String> = specials.iter().filter(|b| !g.variants[**b].layer).collect();
                let weights: Vec<f64> = bases.iter().map(|b| g.variants[**b].chance).collect();
                if let Some(i) = choose_weighted(&weights) {
                    return combine_variant(v, bases[i]);
                }
            }
            return (*v).clone();
        }
    }
    "normal".into()
}

/// Karta i wariant ze skrzynki (karty specjalne nie wypadają ze skrzynek). None: wszystkie wagi zerowe.
pub fn roll(cat: &Catalog, cr: &Crate) -> Option<(Arc<Person>, String)> {
    let g = g();
    let people: Vec<&Arc<Person>> = cat.crate_people(cr).collect();
    let present: std::collections::HashSet<&str> = people.iter().filter(|p| !p.is_special()).map(|p| p.rarity.as_str()).collect();
    let weights: Vec<f64> =
        g.rarity_order.iter().map(|r| if present.contains(r.as_str()) { cr.weight(r) } else { 0.0 }).collect();
    let rarity = &g.rarity_order[choose_weighted(&weights)?];
    let pool: Vec<&&Arc<Person>> = people.iter().filter(|p| &p.rarity == rarity).collect();
    let person = (**pool.choose(&mut rand::thread_rng())?).clone();
    let variant = roll_from(1.0, &cat.crate_variants(cr, Some(&person)), true); // tylko warianty przypięte do skrzynki
    Some((person, variant))
}

/// Pieniądze ze skrzynki z pieniędzmi: min + (max - min) * los^curve, zaokrąglone do 100 gr
pub fn roll_money(kind: &str) -> i64 {
    let c = &g().money_chests[kind];
    let amount = c.min as f64 + (c.max - c.min) as f64 * random().powf(c.curve);
    ((amount / 100.0).round_ties_even() as i64) * 100
}

/// Wygrana w kartach o łącznej wartości value: losowe karty ze skrzynek w sklepie (bez tajnych) w wariantach
/// z CASINO_VARIANTS - za każdym razem jedna z najdroższych, które się mieszczą (CASINO_TOP).
/// Zwraca ([(karta, wariant)], reszta w pieniądzach).
pub fn house_cards(cat: &Catalog, value: i64) -> (Vec<(Arc<Person>, String)>, i64) {
    let g = g();
    let mut pool: Vec<(i64, &Arc<Person>, &String)> = cat
        .people
        .values()
        .filter(|p| p.forge && !p.is_secret())
        .flat_map(|p| g.casino_variants.iter().map(move |v| (p.value(v), p, v)))
        .collect();
    pool.sort_by_key(|x| -x.0); // stabilne, jak sorted()
    let (mut out, mut left) = (vec![], value);
    let mut rng = rand::thread_rng();
    while out.len() < g.roulette.max_payout_cards {
        let fit: Vec<&(i64, &Arc<Person>, &String)> = pool.iter().filter(|x| x.0 <= left).collect();
        let Some(top) = fit.first() else { break };
        let limit = top.0 as f64 * g.casino_top;
        let best: Vec<&&(i64, &Arc<Person>, &String)> = fit.iter().filter(|x| x.0 as f64 >= limit).collect();
        let Some(pick) = best.choose(&mut rng) else { break };
        out.push(((*pick.1).clone(), pick.2.clone()));
        left -= pick.0;
    }
    (out, left)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn variants_and_payouts() {
        let cat = crate::catalog::build(&[], &[]);
        for _ in 0..2000 {
            let v = roll_variant(1.0, &[]);
            assert!(!g().variants[&v].exclusive, "{v}");
        }
        let hw = vec!["halloween".to_string(), "lantern".to_string(), "devil".to_string()];
        for _ in 0..500 {
            let v = roll_variant(1.0, &hw);
            assert!(v == "lantern" || v == "devil" || v.starts_with("halloween"), "{v}");
        }
        // skrzynka: tylko warianty do niej przypięte (bez przypiętych - same zwykłe karty)
        for _ in 0..2000 {
            assert_eq!(roll_from(1.0, &[], true), "normal");
            let v = roll_from(1.0, &["gold".to_string()], true);
            assert!(v == "normal" || v == "gold", "{v}");
        }
        let (cards, money) = house_cards(&cat, 12_345);
        let total: i64 = cards.iter().map(|(p, v)| p.value(v)).sum::<i64>() + money;
        assert_eq!(total, 12_345);
        assert!(money >= 0);
        let (p, _) = roll(&cat, &cat.crates["pl"]).unwrap();
        assert!(p.crates.contains(&"pl".to_string()));
        assert!(roll(&cat, &cat.crates["specjalne"]).is_none());
        for _ in 0..100 {
            let m = roll_money("daily");
            assert!((5_000..=20_000).contains(&m) && m % 100 == 0);
        }
    }
}
